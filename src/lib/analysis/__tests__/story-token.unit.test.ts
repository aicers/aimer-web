import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import type { RedactionMap } from "@/lib/redaction";
import { buildOwnedDomainSet } from "../../redaction/domains";
import { buildRangeSet } from "../../redaction/ranges";
import type { RangeSet } from "../../redaction/types";
import { buildStoryTokenMap, scanStoryAnalysisForLeaks } from "../story-token";
import { restoreStoryAnalysisTokens } from "../story-token-restore";

const EMPTY_RANGES: RangeSet = buildRangeSet([]);

describe("buildStoryTokenMap", () => {
  it("rewrites event-scope tokens to 1-based story-scope tokens", () => {
    // The member index is 1-based end to end (RFC 0002 #344): the first
    // member's tokens carry `E1`, not `E0`, so the embedded `E{i}` equals
    // aimer's `StoryMemberInput.ordinal`.
    const out = buildStoryTokenMap([
      {
        aiceId: "aice-1",
        eventKey: "1001",
        event: { ip: "<<REDACTED_IP_001>>" },
      },
      {
        aiceId: "aice-2",
        eventKey: "2002",
        event: { ip: "<<REDACTED_IP_001>>", mac: "<<REDACTED_MAC_007>>" },
      },
    ]);
    expect(out.rewrittenMembers[0].event).toEqual({
      ip: "<<REDACTED_IP_E1_001>>",
    });
    expect(out.rewrittenMembers[0].index).toBe(1);
    expect(out.rewrittenMembers[1].event).toEqual({
      ip: "<<REDACTED_IP_E2_001>>",
      mac: "<<REDACTED_MAC_E2_007>>",
    });
    expect(out.rewrittenMembers[1].index).toBe(2);
    expect(out.refs).toEqual([
      { index: 1, aiceId: "aice-1", eventKey: "1001" },
      { index: 2, aiceId: "aice-2", eventKey: "2002" },
    ]);
    expect(Array.from(out.allowedTokens).sort()).toEqual([
      "<<REDACTED_IP_E1_001>>",
      "<<REDACTED_IP_E2_001>>",
      "<<REDACTED_MAC_E2_007>>",
    ]);
  });

  it("namespaces DOMAIN tokens to story scope (RFC 0001 Amendment A.2)", () => {
    const out = buildStoryTokenMap([
      {
        aiceId: "aice-1",
        eventKey: "1001",
        event: { host: "<<REDACTED_DOMAIN_001>>" },
      },
    ]);
    expect(out.rewrittenMembers[0].event).toEqual({
      host: "<<REDACTED_DOMAIN_E1_001>>",
    });
    expect(Array.from(out.allowedTokens)).toEqual([
      "<<REDACTED_DOMAIN_E1_001>>",
    ]);
  });

  it("returns empty refs and tokens for zero members", () => {
    const out = buildStoryTokenMap([]);
    expect(out.rewrittenMembers).toEqual([]);
    expect(out.refs).toEqual([]);
    expect(out.allowedTokens.size).toBe(0);
  });

  it("round-trips 1-based ordinals through build and restore", () => {
    // The ordinal baked into the token (`E{i}`), the `refs[].index`, and
    // the restore lookup key must all agree on the 1-based namespace so
    // the analyst UI resolves the right per-member redaction map.
    const out = buildStoryTokenMap([
      { aiceId: "a1", eventKey: "1", event: { ip: "<<REDACTED_IP_001>>" } },
      { aiceId: "a2", eventKey: "2", event: { ip: "<<REDACTED_IP_001>>" } },
    ]);
    expect(out.refs.map((r) => r.index)).toEqual([1, 2]);

    // `mapsByIndex` is keyed by `refs[].index` (1-based), exactly how
    // `story-result-page-loader.ts` builds it.
    const mkMap = (value: string): RedactionMap => ({
      "<<REDACTED_IP_001>>": { value, kind: "ip" },
    });
    const mapsByIndex = new Map<number, RedactionMap>([
      [1, mkMap("10.0.0.1")],
      [2, mkMap("10.0.0.2")],
    ]);
    const text =
      "Source <<REDACTED_IP_E1_001>> talked to <<REDACTED_IP_E2_001>>.";
    expect(restoreStoryAnalysisTokens(text, mapsByIndex)).toBe(
      "Source 10.0.0.1 talked to 10.0.0.2.",
    );
  });
});

describe("scanStoryAnalysisForLeaks", () => {
  const allowed = new Set(["<<REDACTED_IP_E0_001>>", "<<REDACTED_IP_E1_004>>"]);

  it("returns no leaks when only mapped story tokens appear", () => {
    const r = scanStoryAnalysisForLeaks(
      "Saw <<REDACTED_IP_E0_001>> talking to <<REDACTED_IP_E1_004>>.",
      allowed,
      EMPTY_RANGES,
    );
    expect(r.hasLeak).toBe(false);
    expect(r.leaks).toEqual([]);
  });

  it("flags unmapped member indices as hallucinations", () => {
    const r = scanStoryAnalysisForLeaks(
      "Suspicious traffic from <<REDACTED_IP_E9_007>>.",
      allowed,
      EMPTY_RANGES,
    );
    expect(r.hasLeak).toBe(true);
    expect(r.leaks[0]).toMatchObject({
      kind: "unmapped_story_token",
      index: 9,
    });
  });

  it("flags fabricated token numbers even when the member index exists", () => {
    // Member 0 only produced `<<REDACTED_IP_E0_001>>`; the LLM
    // emitting `<<REDACTED_IP_E0_999>>` is a fabrication because
    // token 999 was never in the input. The hallucination scan
    // must reject this, not just unknown member indices.
    const r = scanStoryAnalysisForLeaks(
      "Talked to <<REDACTED_IP_E0_999>>.",
      allowed,
      EMPTY_RANGES,
    );
    expect(r.hasLeak).toBe(true);
    expect(r.leaks[0]).toMatchObject({
      kind: "unmapped_story_token",
      match: "<<REDACTED_IP_E0_999>>",
      index: 0,
    });
  });

  it("flags residual event-scope tokens (the LLM cannot have read one)", () => {
    const r = scanStoryAnalysisForLeaks(
      "Event-scope leak: <<REDACTED_IP_001>>.",
      allowed,
      EMPTY_RANGES,
    );
    expect(r.hasLeak).toBe(true);
    expect(r.leaks.some((l) => l.kind === "residual_event_token")).toBe(true);
  });

  it("flags unknown-kind tokens the kind-pinned matchers miss (#380)", () => {
    // The redaction engine only emits IP/EMAIL/MAC, so a HOSTNAME token
    // is foreign to STORY_TOKEN_RE and RESIDUAL_EVENT_TOKEN_RE. The
    // kind-agnostic backstop must still fail the job for the story `E{i}`
    // and bare event scopes — this is the first backstop that should
    // have caught the observed leak.
    for (const token of [
      "<<REDACTED_HOSTNAME_E1_001>>",
      "<<REDACTED_HOSTNAME_001>>",
    ]) {
      const r = scanStoryAnalysisForLeaks(
        `synthesized ${token}`,
        allowed,
        EMPTY_RANGES,
      );
      expect(r.hasLeak).toBe(true);
      expect(r.leaks).toContainEqual(
        expect.objectContaining({ kind: "unknown_kind_token", match: token }),
      );
    }
  });

  it("does not flag mapped story tokens via the backstop (no false positive)", () => {
    const r = scanStoryAnalysisForLeaks(
      "Saw <<REDACTED_IP_E0_001>> talking to <<REDACTED_IP_E1_004>>.",
      allowed,
      EMPTY_RANGES,
    );
    expect(r.hasLeak).toBe(false);
    expect(r.leaks.some((l) => l.kind === "unknown_kind_token")).toBe(false);
  });

  it("flags plaintext IPv4 / email / MAC PII", () => {
    const r = scanStoryAnalysisForLeaks(
      "User alice@example.com from 10.0.0.5 (mac 00:11:22:33:44:55).",
      allowed,
      EMPTY_RANGES,
    );
    expect(r.hasLeak).toBe(true);
    const kinds = r.leaks.map((l) => l.kind);
    expect(kinds).toContain("plaintext_pii");
  });

  it("flags plaintext IPv6 PII (private and in-range public)", () => {
    // Private IPv6 is always redacted; the public IPv6 here is inside
    // the configured range, so the engine would have tokenised both —
    // an IPv6 literal in the analysis output is then either a model
    // hallucination or a leak, both blockers per #296.
    const r = scanStoryAnalysisForLeaks(
      "Suspicious peer fc00::1 contacted 2001:db8::dead:beef over TCP",
      allowed,
      buildRangeSet(["2001:db8::/32"]),
    );
    expect(r.hasLeak).toBe(true);
    const matches = r.leaks
      .filter((l) => l.kind === "plaintext_pii")
      .map((l) => l.match);
    expect(matches).toContain("fc00::1");
    expect(matches).toContain("2001:db8::dead:beef");
  });

  it("does not flag colon-grouped non-IPv6 text (e.g. timestamps)", () => {
    // The candidate regex matches `09:30:00` but parseIPv6 rejects
    // it because each group must be valid hex of length 1-4 with
    // proper grouping rules; verify the scan stays quiet.
    const r = scanStoryAnalysisForLeaks(
      "Activity at 09:30:00 then again at 11:45:12 from <<REDACTED_IP_E0_001>>.",
      allowed,
      EMPTY_RANGES,
    );
    expect(r.hasLeak).toBe(false);
  });

  // Regression for #296 round 5 (item 1): under a NON-EMPTY range set,
  // the redaction engine intentionally lets public IPs that fall
  // outside the configured CIDRs through unredacted into the prompt.
  // The leak scan must NOT flag those when the LLM faithfully repeats
  // them, otherwise valid stories permanently fail for customers that
  // narrowed their redaction scope.
  describe("IP policy alignment with the redaction engine", () => {
    const narrowRanges = buildRangeSet(["203.0.113.0/24", "2001:db8::/32"]);

    it("does not flag public IPv4 outside the configured range", () => {
      // 8.8.8.8 is public and not in 203.0.113.0/24 → engine would
      // not have redacted it, so an echo in the output is not a leak.
      const r = scanStoryAnalysisForLeaks(
        "Beacon to 8.8.8.8 observed.",
        allowed,
        narrowRanges,
      );
      expect(r.leaks.filter((l) => l.match === "8.8.8.8")).toEqual([]);
    });

    it("still flags public IPv4 inside the configured range", () => {
      // 203.0.113.5 IS in the redacted range → engine would have
      // tokenised it; an unredacted occurrence in the output is a leak.
      const r = scanStoryAnalysisForLeaks(
        "Beacon to 203.0.113.5 observed.",
        allowed,
        narrowRanges,
      );
      expect(
        r.leaks.some(
          (l) => l.kind === "plaintext_pii" && l.match === "203.0.113.5",
        ),
      ).toBe(true);
    });

    it("still flags private IPv4 even when ranges are non-empty", () => {
      const r = scanStoryAnalysisForLeaks(
        "Internal host 10.0.0.5 contacted.",
        allowed,
        narrowRanges,
      );
      expect(
        r.leaks.some(
          (l) => l.kind === "plaintext_pii" && l.match === "10.0.0.5",
        ),
      ).toBe(true);
    });

    it("does not flag public IPv6 outside the configured range", () => {
      // 2606:4700:4700::1111 is public and not in 2001:db8::/32.
      // The trailing space (not punctuation) keeps the IPv6 candidate
      // regex's right-boundary lookahead satisfied.
      const r = scanStoryAnalysisForLeaks(
        "Resolver was 2606:4700:4700::1111 today",
        allowed,
        narrowRanges,
      );
      expect(r.leaks.some((l) => l.match === "2606:4700:4700::1111")).toEqual(
        false,
      );
    });

    it("still flags public IPv6 inside the configured range", () => {
      const r = scanStoryAnalysisForLeaks(
        "Beacon to 2001:db8::dead:beef seen",
        allowed,
        narrowRanges,
      );
      expect(
        r.leaks.some(
          (l) =>
            l.kind === "plaintext_pii" && l.match === "2001:db8::dead:beef",
        ),
      ).toBe(true);
    });

    it("does not flag public IPs when the range set is empty (pass-through default)", () => {
      const r = scanStoryAnalysisForLeaks(
        "Public 8.8.8.8 and 2606:4700:4700::1111 echoed",
        allowed,
        EMPTY_RANGES,
      );
      const matches = r.leaks
        .filter((l) => l.kind === "plaintext_pii")
        .map((l) => l.match);
      expect(matches).not.toContain("8.8.8.8");
      expect(matches).not.toContain("2606:4700:4700::1111");
    });

    it("still flags private IPs when the range set is empty", () => {
      const r = scanStoryAnalysisForLeaks(
        "Internal host 10.0.0.5 and fc00::1 contacted",
        allowed,
        EMPTY_RANGES,
      );
      const matches = r.leaks
        .filter((l) => l.kind === "plaintext_pii")
        .map((l) => l.match);
      expect(matches).toContain("10.0.0.5");
      expect(matches).toContain("fc00::1");
    });
  });

  // RFC 0001 Amendment A.2: a customer-owned domain the LLM echoes in
  // plaintext (instead of as a token) is a leak the engine would have
  // tokenised on the input side; external domains stay visible.
  describe("owned-domain policy alignment", () => {
    const owned = buildOwnedDomainSet(["customer.example"]);

    it("flags an owned domain echoed verbatim", () => {
      const r = scanStoryAnalysisForLeaks(
        "Beacon from vpn.customer.example observed.",
        allowed,
        EMPTY_RANGES,
        owned,
      );
      expect(
        r.leaks.some(
          (l) =>
            l.kind === "plaintext_pii" && l.match === "vpn.customer.example",
        ),
      ).toBe(true);
    });

    it("flags the registered apex domain itself", () => {
      const r = scanStoryAnalysisForLeaks(
        "Domain customer.example resolved.",
        allowed,
        EMPTY_RANGES,
        owned,
      );
      expect(
        r.leaks.some(
          (l) => l.kind === "plaintext_pii" && l.match === "customer.example",
        ),
      ).toBe(true);
    });

    it("does not flag an external domain (pass-through)", () => {
      const r = scanStoryAnalysisForLeaks(
        "C2 host evil-attacker.example contacted.",
        allowed,
        EMPTY_RANGES,
        owned,
      );
      expect(r.leaks.some((l) => l.match === "evil-attacker.example")).toBe(
        false,
      );
    });

    it("does not flag a domain that only resembles an owned suffix", () => {
      // `notcustomer.example` is NOT a subdomain of `customer.example`.
      const r = scanStoryAnalysisForLeaks(
        "Saw notcustomer.example in logs.",
        allowed,
        EMPTY_RANGES,
        owned,
      );
      expect(r.leaks.some((l) => l.match === "notcustomer.example")).toBe(
        false,
      );
    });

    it("flags an IDN owned domain echoed in its U-label form", () => {
      // The suffix is registered as punycode; the U-label echo must still
      // be caught because `findOwnedDomainLeaks` folds before matching.
      const idnOwned = buildOwnedDomainSet(["xn--80ak6aa92e.example"]);
      const r = scanStoryAnalysisForLeaks(
        "Phish from www.аррӏе.example seen",
        allowed,
        EMPTY_RANGES,
        idnOwned,
      );
      expect(r.leaks.some((l) => l.kind === "plaintext_pii")).toBe(true);
    });

    it("flags nothing for domains when the owned set is empty (default)", () => {
      const r = scanStoryAnalysisForLeaks(
        "Beacon from vpn.customer.example observed.",
        allowed,
        EMPTY_RANGES,
      );
      expect(r.leaks.some((l) => l.match === "vpn.customer.example")).toBe(
        false,
      );
    });
  });
});
