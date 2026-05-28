import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { buildStoryTokenMap, scanStoryAnalysisForLeaks } from "../story-token";

describe("buildStoryTokenMap", () => {
  it("rewrites event-scope tokens to story-scope with the member index", () => {
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
      ip: "<<REDACTED_IP_E0_001>>",
    });
    expect(out.rewrittenMembers[1].event).toEqual({
      ip: "<<REDACTED_IP_E1_001>>",
      mac: "<<REDACTED_MAC_E1_007>>",
    });
    expect(out.refs).toEqual([
      { index: 0, aiceId: "aice-1", eventKey: "1001" },
      { index: 1, aiceId: "aice-2", eventKey: "2002" },
    ]);
    expect(Array.from(out.allowedTokens).sort()).toEqual([
      "<<REDACTED_IP_E0_001>>",
      "<<REDACTED_IP_E1_001>>",
      "<<REDACTED_MAC_E1_007>>",
    ]);
  });

  it("returns empty refs and tokens for zero members", () => {
    const out = buildStoryTokenMap([]);
    expect(out.rewrittenMembers).toEqual([]);
    expect(out.refs).toEqual([]);
    expect(out.allowedTokens.size).toBe(0);
  });
});

describe("scanStoryAnalysisForLeaks", () => {
  const allowed = new Set(["<<REDACTED_IP_E0_001>>", "<<REDACTED_IP_E1_004>>"]);

  it("returns no leaks when only mapped story tokens appear", () => {
    const r = scanStoryAnalysisForLeaks(
      "Saw <<REDACTED_IP_E0_001>> talking to <<REDACTED_IP_E1_004>>.",
      allowed,
    );
    expect(r.hasLeak).toBe(false);
    expect(r.leaks).toEqual([]);
  });

  it("flags unmapped member indices as hallucinations", () => {
    const r = scanStoryAnalysisForLeaks(
      "Suspicious traffic from <<REDACTED_IP_E9_007>>.",
      allowed,
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
    );
    expect(r.hasLeak).toBe(true);
    expect(r.leaks.some((l) => l.kind === "residual_event_token")).toBe(true);
  });

  it("flags plaintext IPv4 / email / MAC PII", () => {
    const r = scanStoryAnalysisForLeaks(
      "User alice@example.com from 10.0.0.5 (mac 00:11:22:33:44:55).",
      allowed,
    );
    expect(r.hasLeak).toBe(true);
    const kinds = r.leaks.map((l) => l.kind);
    expect(kinds).toContain("plaintext_pii");
  });

  it("flags plaintext IPv6 PII (private and public)", () => {
    // The redaction engine would have tokenised any IPv6 the prompt
    // carried in, so an IPv6 literal in the analysis output is either
    // a model hallucination or a leak — both blockers per #296.
    const r = scanStoryAnalysisForLeaks(
      "Suspicious peer fc00::1 contacted 2001:db8::dead:beef over TCP",
      allowed,
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
    );
    expect(r.hasLeak).toBe(false);
  });
});
