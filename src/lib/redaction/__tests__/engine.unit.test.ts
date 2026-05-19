import { describe, expect, it } from "vitest";
import {
  computePolicyVersion,
  ENGINE_VERSION,
  redact,
  scanHallucinations,
} from "../engine";
import { buildRangeSet } from "../ranges";
import type { RedactionMap } from "../types";

const EMPTY_RANGES = buildRangeSet([]);

function makeInput(payload: unknown, existingMap: RedactionMap = {}) {
  return {
    payload,
    existingMap,
    ranges: EMPTY_RANGES,
    engineVersion: ENGINE_VERSION,
  };
}

describe("redaction engine — private IPs always redact", () => {
  it("redacts IPv4 private ranges", () => {
    const cases = ["10.0.0.1", "172.16.5.4", "192.168.1.1", "127.0.0.1"];
    for (const ip of cases) {
      const { redacted, mergedMap } = redact(makeInput({ addr: ip }));
      const value = (redacted as { addr: string }).addr;
      expect(value).toMatch(/^<<REDACTED_IP_\d{3}>>$/);
      const entry = Object.values(mergedMap).find((e) => e.value === ip);
      expect(entry).toBeDefined();
      expect(entry?.kind).toBe("ip");
    }
  });

  it("redacts IPv4 link-local (169.254.0.0/16)", () => {
    const { redacted } = redact(makeInput({ addr: "169.254.1.2" }));
    expect((redacted as { addr: string }).addr).toMatch(/<<REDACTED_IP_/);
  });

  it("redacts IPv6 private ranges (ULA, link-local, loopback)", () => {
    const cases = ["fc00::1", "fe80::1", "::1"];
    for (const ip of cases) {
      const { redacted } = redact(makeInput({ addr: ip }));
      const value = (redacted as { addr: string }).addr;
      expect(value).toMatch(/^<<REDACTED_IP_\d{3}>>$/);
    }
  });
});

describe("redaction engine — public IPs", () => {
  it("redacts ALL public IPs when range set is empty (safe default)", () => {
    const { redacted, mergedMap } = redact(
      makeInput({ src: "203.0.113.5", dst: "198.51.100.10" }),
    );
    expect((redacted as { src: string }).src).toMatch(/^<<REDACTED_IP_/);
    expect((redacted as { dst: string }).dst).toMatch(/^<<REDACTED_IP_/);
    expect(Object.keys(mergedMap)).toHaveLength(2);
  });

  it("redacts only customer-range matches when range set is non-empty", () => {
    const ranges = buildRangeSet(["203.0.113.0/24"]);
    const { redacted } = redact({
      payload: { in_range: "203.0.113.7", out_of_range: "198.51.100.1" },
      existingMap: {},
      ranges,
      engineVersion: ENGINE_VERSION,
    });
    expect((redacted as { in_range: string }).in_range).toMatch(
      /<<REDACTED_IP_/,
    );
    // Out-of-range public IP passes through under a non-empty set.
    expect((redacted as { out_of_range: string }).out_of_range).toBe(
      "198.51.100.1",
    );
  });

  it("redacts public IPv6 by customer CIDR", () => {
    const ranges = buildRangeSet(["2001:db8::/32"]);
    const { redacted } = redact({
      payload: { in_range: "2001:db8::1234", out_of_range: "2607:f8b0::1" },
      existingMap: {},
      ranges,
      engineVersion: ENGINE_VERSION,
    });
    expect((redacted as { in_range: string }).in_range).toMatch(
      /<<REDACTED_IP_/,
    );
    expect((redacted as { out_of_range: string }).out_of_range).toBe(
      "2607:f8b0::1",
    );
  });
});

describe("redaction engine — emails and MACs", () => {
  it("redacts email addresses", () => {
    const { redacted, mergedMap } = redact(
      makeInput("contact alice@example.com or bob@example.org"),
    );
    expect(redacted).toMatch(/<<REDACTED_EMAIL_001>>/);
    expect(redacted).toMatch(/<<REDACTED_EMAIL_002>>/);
    const values = Object.values(mergedMap).map((e) => e.value);
    expect(values).toContain("alice@example.com");
    expect(values).toContain("bob@example.org");
  });

  it("redacts MAC addresses (colon and hyphen separators)", () => {
    const { redacted, mergedMap } = redact(
      makeInput("aa:bb:cc:dd:ee:ff and 11-22-33-44-55-66"),
    );
    expect(redacted).toMatch(/<<REDACTED_MAC_001>>/);
    expect(redacted).toMatch(/<<REDACTED_MAC_002>>/);
    expect(Object.keys(mergedMap)).toHaveLength(2);
  });
});

describe("redaction engine — token assignment invariants", () => {
  it("collapses duplicate entities within one event to a single token", () => {
    const { redacted, mergedMap } = redact(
      makeInput({
        rule_a: "10.0.0.1 contacted 10.0.0.1 again",
        rule_b: "still 10.0.0.1",
      }),
    );
    // 10 mentions of the same IP -> 1 map entry, same token in every spot.
    const tokens = Array.from(
      JSON.stringify(redacted).matchAll(/<<REDACTED_IP_\d{3}>>/g),
    ).map((m) => m[0]);
    expect(tokens.length).toBe(3);
    expect(new Set(tokens).size).toBe(1);
    expect(Object.keys(mergedMap)).toHaveLength(1);
  });

  it("reuses tokens from an existing map (first-writer-creates)", () => {
    const existingMap: RedactionMap = {
      "<<REDACTED_IP_001>>": { kind: "ip", value: "10.0.0.1" },
    };
    const { redacted, mergedMap, mapChanged } = redact(
      makeInput({ src: "10.0.0.1" }, existingMap),
    );
    expect((redacted as { src: string }).src).toBe("<<REDACTED_IP_001>>");
    expect(mergedMap).toEqual(existingMap);
    expect(mapChanged).toBe(false);
  });

  it("appends new tokens with the next free counter per kind", () => {
    const existingMap: RedactionMap = {
      "<<REDACTED_IP_001>>": { kind: "ip", value: "10.0.0.1" },
      "<<REDACTED_IP_002>>": { kind: "ip", value: "10.0.0.2" },
    };
    const { redacted, mergedMap, mapChanged } = redact(
      makeInput({ src: "10.0.0.3", from: "user@example.com" }, existingMap),
    );
    expect((redacted as { src: string }).src).toBe("<<REDACTED_IP_003>>");
    expect((redacted as { from: string }).from).toBe("<<REDACTED_EMAIL_001>>");
    expect(mergedMap["<<REDACTED_IP_001>>"]).toEqual(
      existingMap["<<REDACTED_IP_001>>"],
    );
    expect(mergedMap["<<REDACTED_IP_003>>"]).toEqual({
      kind: "ip",
      value: "10.0.0.3",
    });
    expect(mapChanged).toBe(true);
  });

  it("walks nested JSON and preserves structural keys", () => {
    const { redacted } = redact(
      makeInput({
        flow: {
          src: "10.0.0.1",
          dst: ["198.51.100.1", { aux: "fe80::1" }],
        },
      }),
    );
    const out = redacted as {
      flow: { src: string; dst: [string, { aux: string }] };
    };
    expect(out.flow.src).toMatch(/<<REDACTED_IP_/);
    expect(out.flow.dst[0]).toMatch(/<<REDACTED_IP_/);
    expect(out.flow.dst[1].aux).toMatch(/<<REDACTED_IP_/);
  });

  it("throws when an existing map would violate token-value injectivity", () => {
    // Same value mapped under two kinds is a corrupted map state —
    // shared-map invariant 3 says this is unreachable in correct
    // code; the engine should flag it loudly.
    const corruptMap: RedactionMap = {
      "<<REDACTED_EMAIL_001>>": { kind: "email", value: "10.0.0.1" },
    };
    expect(() => redact(makeInput({ src: "10.0.0.1" }, corruptMap))).toThrow();
  });
});

describe("redaction engine — policy_version", () => {
  it("computes composite engine|ranges version with sentinel for empty set", () => {
    const version = computePolicyVersion("1.0.0", EMPTY_RANGES);
    expect(version).toBe("engine:1.0.0|ranges:empty");
  });

  it("includes a stable hash prefix for non-empty range sets", () => {
    const ranges = buildRangeSet(["203.0.113.0/24", "198.51.100.0/24"]);
    const a = computePolicyVersion("1.0.0", ranges);
    const b = computePolicyVersion(
      "1.0.0",
      buildRangeSet(["198.51.100.0/24", "203.0.113.0/24"]),
    );
    // Sorted normalisation -> hash is order-independent.
    expect(a).toBe(b);
    expect(a).toMatch(/^engine:1\.0\.0\|ranges:[0-9a-f]{12}$/);
  });
});

describe("redaction engine — hallucination scan", () => {
  it("flags entities the LLM emitted that were not in the input", () => {
    const existingMap: RedactionMap = {
      "<<REDACTED_IP_001>>": { kind: "ip", value: "10.0.0.1" },
    };
    const response =
      "The attacker 10.0.0.1 also reached 8.8.8.8 from eve@evil.com";
    const result = scanHallucinations(response, existingMap, EMPTY_RANGES);
    // 10.0.0.1 echoed by the LLM is replaced by its existing token,
    // not left as plaintext (storage contract: analysis_text holds
    // no raw entities).
    expect(result.scanned).toContain("<<REDACTED_IP_001>>");
    expect(result.scanned).not.toContain("10.0.0.1");
    // 8.8.8.8 and eve@evil.com are not in the map -> flagged.
    expect(result.scanned).toContain("<<UNVERIFIED_IP_001>>");
    expect(result.scanned).toContain("<<UNVERIFIED_EMAIL_001>>");
    // Known plaintext re-tokenisation does not bump the unverified
    // counters.
    expect(result.counts.ip).toBe(1);
    expect(result.counts.email).toBe(1);
  });

  it("resets counters per response (RFC 0001 §LLM hallucination handling)", () => {
    // Two separate responses each start at 001.
    const r1 = scanHallucinations("see 8.8.8.8", {}, EMPTY_RANGES);
    const r2 = scanHallucinations("see 1.1.1.1", {}, EMPTY_RANGES);
    expect(r1.scanned).toContain("<<UNVERIFIED_IP_001>>");
    expect(r2.scanned).toContain("<<UNVERIFIED_IP_001>>");
  });
});
