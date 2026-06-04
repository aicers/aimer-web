import { describe, expect, it } from "vitest";
import {
  ipInCidr,
  NORMALIZATION_VERSION,
  NormalizationError,
  normalizeDomain,
  normalizeHash,
  normalizeIp,
  normalizeUrl,
} from "../normalization";

describe("normalizeIp — public/non-public classification", () => {
  it("classifies global unicast as public", () => {
    const v4 = normalizeIp("45.66.230.5");
    expect(v4.isPublic).toBe(true);
    expect(v4.neverOffHost).toBe(false);
    const v6 = normalizeIp("2606:4700:4700::1111");
    expect(v6.isPublic).toBe(true);
  });

  it("classifies every non-unicast IPv4 range as non-public", () => {
    const nonPublic = [
      "10.0.0.1", // private
      "127.0.0.1", // loopback
      "169.254.0.1", // linkLocal
      "255.255.255.255", // broadcast
      "224.0.0.1", // multicast
      "0.0.0.0", // unspecified
      "100.64.0.1", // carrierGradeNat
      "203.0.113.10", // reserved (TEST-NET-3)
      "198.51.100.7", // reserved (TEST-NET-2)
      "240.0.0.1", // reserved
    ];
    for (const ip of nonPublic) {
      const n = normalizeIp(ip);
      expect(n.isPublic, ip).toBe(false);
      expect(n.neverOffHost, ip).toBe(true);
    }
  });

  it("classifies non-unicast IPv6 ranges as non-public", () => {
    const nonPublic = [
      "fc00::1", // uniqueLocal
      "fe80::1", // linkLocal
      "ff02::1", // multicast
      "::1", // loopback
      "::", // unspecified
      "2002:c0a8::1", // 6to4
      "2001:0::1", // teredo
      "2001:db8::1", // reserved (documentation)
    ];
    for (const ip of nonPublic) {
      expect(normalizeIp(ip).isPublic, ip).toBe(false);
    }
  });

  it("re-evaluates the embedded IPv4 of an IPv4-mapped IPv6 address", () => {
    expect(normalizeIp("::ffff:10.0.0.1").isPublic).toBe(false);
    expect(normalizeIp("::ffff:45.66.230.5").isPublic).toBe(true);
  });

  it("produces the canonical address form and stamps the version", () => {
    const n = normalizeIp("45.66.230.5");
    expect(n.value).toBe("45.66.230.5");
    expect(n.matchValues).toEqual(["45.66.230.5"]);
    expect(n.normalizationVersion).toBe(NORMALIZATION_VERSION);
  });

  it("throws on invalid input", () => {
    expect(() => normalizeIp("not-an-ip")).toThrow(NormalizationError);
  });
});

describe("ipInCidr — CIDR membership", () => {
  it("matches addresses inside a v4 CIDR and rejects outside", () => {
    expect(ipInCidr("198.51.100.42", "198.51.100.0/24")).toBe(true);
    expect(ipInCidr("198.51.101.1", "198.51.100.0/24")).toBe(false);
  });

  it("matches v6 membership and rejects cross-version", () => {
    expect(ipInCidr("2001:db8::5", "2001:db8::/32")).toBe(true);
    expect(ipInCidr("198.51.100.1", "2001:db8::/32")).toBe(false);
  });

  it("returns false on malformed input rather than throwing", () => {
    expect(ipInCidr("garbage", "198.51.100.0/24")).toBe(false);
    expect(ipInCidr("198.51.100.1", "garbage")).toBe(false);
  });
});

describe("normalizeDomain — punycode / IDN", () => {
  it("keeps both A-label and U-label in matchValues, value is the A-label", () => {
    const n = normalizeDomain("Bücher.DE.");
    expect(n.value).toBe("xn--bcher-kva.de");
    expect(n.matchValues).toContain("xn--bcher-kva.de");
    expect(n.matchValues).toContain("bücher.de");
  });

  it("lowercases and strips trailing dot for an ASCII domain", () => {
    const n = normalizeDomain("Example.COM.");
    expect(n.value).toBe("example.com");
    // No distinct U-label, so only one match value.
    expect(n.matchValues).toEqual(["example.com"]);
  });

  it("throws on empty input", () => {
    expect(() => normalizeDomain("   ")).toThrow(NormalizationError);
  });
});

describe("normalizeUrl — canonicalization vectors + derived indicators", () => {
  const vectors: [string, string][] = [
    ["HTTP://Example.COM:80", "http://example.com/"],
    ["https://example.com:443/P?b=2&a=1#frag", "https://example.com/P?b=2&a=1"],
    ["http://example.com/a%2fb", "http://example.com/a%2Fb"],
    ["http://Example.com/Path/", "http://example.com/Path/"],
  ];

  for (const [input, expected] of vectors) {
    it(`canonicalizes ${input}`, () => {
      const n = normalizeUrl(input);
      expect(n.value).toBe(expected);
      expect(n.derived?.url).toBe(expected);
    });
  }

  it("derives { url, host, registeredDomain }", () => {
    const n = normalizeUrl("https://a.b.example.co.uk/path?x=1");
    expect(n.derived).toEqual({
      url: "https://a.b.example.co.uk/path?x=1",
      host: "a.b.example.co.uk",
      registeredDomain: "example.co.uk",
    });
  });

  it("throws on unparseable input", () => {
    expect(() => normalizeUrl("not a url")).toThrow(NormalizationError);
  });
});

describe("normalizeHash — hash-type distinction", () => {
  it("distinguishes MD5 / SHA-1 / SHA-256 by length and lowercases", () => {
    expect(normalizeHash("D".repeat(32)).hashType).toBe("MD5");
    expect(normalizeHash("a".repeat(40)).hashType).toBe("SHA1");
    const sha256 = normalizeHash("AB".repeat(32));
    expect(sha256.hashType).toBe("SHA256");
    expect(sha256.value).toBe("ab".repeat(32));
  });

  it("throws on non-hex or unknown-length input", () => {
    expect(() => normalizeHash("zz")).toThrow(NormalizationError);
    expect(() => normalizeHash("g".repeat(32))).toThrow(NormalizationError);
  });
});
