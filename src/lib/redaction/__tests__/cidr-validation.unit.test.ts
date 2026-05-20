import { describe, expect, it } from "vitest";
import {
  isReservedPrivate,
  overlaps,
  parseCidrInput,
  RANGE_CAP_PER_CUSTOMER,
  validateNewRange,
} from "../cidr-validation";

function parseOrThrow(value: string) {
  const parsed = parseCidrInput(value);
  if (!parsed) throw new Error(`unexpected parse failure for ${value}`);
  return parsed;
}

describe("parseCidrInput", () => {
  it("returns null for syntactically invalid input", () => {
    expect(parseCidrInput("not-a-cidr")).toBeNull();
    expect(parseCidrInput("999.0.0.0/24")).toBeNull();
    expect(parseCidrInput("203.0.113.0")).toBeNull();
    expect(parseCidrInput("")).toBeNull();
  });

  it("normalises host bits to zero", () => {
    expect(parseCidrInput("203.0.113.5/24")?.normalised).toBe("203.0.113.0/24");
    expect(parseCidrInput("2001:db8::1/64")?.normalised).toBe("2001:db8::/64");
  });

  it("returns ipVersion", () => {
    expect(parseCidrInput("8.8.8.0/24")?.ipVersion).toBe(4);
    expect(parseCidrInput("2001:db8::/32")?.ipVersion).toBe(6);
  });
});

describe("isReservedPrivate", () => {
  it("rejects RFC 1918 ranges", () => {
    expect(isReservedPrivate(parseOrThrow("10.0.0.0/8"))).toBe(true);
    expect(isReservedPrivate(parseOrThrow("172.16.0.0/12"))).toBe(true);
    expect(isReservedPrivate(parseOrThrow("192.168.0.0/16"))).toBe(true);
  });

  it("rejects loopback and link-local", () => {
    expect(isReservedPrivate(parseOrThrow("127.0.0.0/8"))).toBe(true);
    expect(isReservedPrivate(parseOrThrow("169.254.0.0/16"))).toBe(true);
  });

  it("rejects IPv6 ULA, loopback, link-local", () => {
    expect(isReservedPrivate(parseOrThrow("fc00::/7"))).toBe(true);
    expect(isReservedPrivate(parseOrThrow("::1/128"))).toBe(true);
    expect(isReservedPrivate(parseOrThrow("fe80::/10"))).toBe(true);
  });

  it("rejects IPv4-mapped IPv6 inside a private v4 range", () => {
    expect(isReservedPrivate(parseOrThrow("::ffff:10.0.0.0/104"))).toBe(true);
  });

  it("accepts a normal public v4 range", () => {
    expect(isReservedPrivate(parseOrThrow("203.0.113.0/24"))).toBe(false);
  });

  it("accepts a normal public v6 range", () => {
    expect(isReservedPrivate(parseOrThrow("2001:db8::/32"))).toBe(false);
  });
});

describe("overlaps", () => {
  it("treats identical CIDRs as overlapping", () => {
    expect(
      overlaps(parseOrThrow("203.0.113.0/24"), parseOrThrow("203.0.113.0/24")),
    ).toBe(true);
  });

  it("detects subset relationships", () => {
    const wider = parseOrThrow("203.0.113.0/24");
    const narrower = parseOrThrow("203.0.113.128/25");
    expect(overlaps(narrower, wider)).toBe(true);
    expect(overlaps(wider, narrower)).toBe(true);
  });

  it("returns false for disjoint ranges", () => {
    expect(
      overlaps(parseOrThrow("203.0.113.0/24"), parseOrThrow("198.51.100.0/24")),
    ).toBe(false);
  });

  it("does not match across IP versions", () => {
    expect(
      overlaps(parseOrThrow("203.0.113.0/24"), parseOrThrow("2001:db8::/32")),
    ).toBe(false);
  });
});

describe("validateNewRange", () => {
  it("rejects invalid syntax", () => {
    const r = validateNewRange("bogus", []);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("cidr_invalid");
  });

  it("rejects RFC 1918 / ULA / loopback / link-local", () => {
    for (const cidr of [
      "10.0.0.0/8",
      "172.16.0.0/12",
      "192.168.0.0/16",
      "127.0.0.0/8",
      "169.254.0.0/16",
      "fc00::/7",
      "fe80::/10",
      "::1/128",
    ]) {
      const r = validateNewRange(cidr, []);
      expect(r.ok, `expected ${cidr} to be rejected`).toBe(false);
      if (!r.ok) expect(r.error).toBe("cidr_private");
    }
  });

  it("rejects duplicates after normalisation", () => {
    const r = validateNewRange("203.0.113.5/24", [
      { normalised: "203.0.113.0/24", ipVersion: 4 },
    ]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("cidr_duplicate");
  });

  it("rejects new ⊂ existing", () => {
    const r = validateNewRange("203.0.113.128/25", [
      { normalised: "203.0.113.0/24", ipVersion: 4 },
    ]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("cidr_overlaps");
  });

  it("rejects new ⊃ existing", () => {
    const r = validateNewRange("203.0.0.0/16", [
      { normalised: "203.0.113.0/24", ipVersion: 4 },
    ]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("cidr_overlaps");
  });

  it("rejects when the cap has been reached", () => {
    const existing = Array.from({ length: RANGE_CAP_PER_CUSTOMER }, (_, i) => ({
      normalised: `203.0.${i}.0/24`,
      ipVersion: 4 as const,
    }));
    const r = validateNewRange("198.51.100.0/24", existing);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("cidr_cap_exceeded");
  });

  it("accepts a fresh, public, non-overlapping CIDR", () => {
    const r = validateNewRange("203.0.113.0/24", [
      { normalised: "198.51.100.0/24", ipVersion: 4 },
    ]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.parsed.normalised).toBe("203.0.113.0/24");
      expect(r.value.parsed.ipVersion).toBe(4);
    }
  });

  it("normalises before duplicate check", () => {
    // Submitting `203.0.113.5/24` against an existing `203.0.113.0/24`
    // should reject as duplicate.
    const r = validateNewRange("203.0.113.5/24", [
      { normalised: "203.0.113.0/24", ipVersion: 4 },
    ]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("cidr_duplicate");
  });

  it("rejects IPv4-mapped IPv6 within an RFC 1918 range", () => {
    const r = validateNewRange("::ffff:10.0.0.0/104", []);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("cidr_private");
  });
});
