import { describe, expect, it } from "vitest";
import {
  buildOwnedDomainSet,
  EMPTY_OWNED_DOMAIN_SET,
  normalizeDomain,
  shouldRedactOwnedDomain,
} from "../domains";

describe("normalizeDomain", () => {
  it("lowercases and strips leading/trailing dots", () => {
    expect(normalizeDomain("Customer.Example")).toBe("customer.example");
    expect(normalizeDomain("example.com.")).toBe("example.com");
    expect(normalizeDomain(".domain.example")).toBe("domain.example");
    expect(normalizeDomain("  Foo.Bar.Example  ")).toBe("foo.bar.example");
  });

  it("folds IDN U-labels to punycode A-labels", () => {
    // U-label and its A-label normalise to the same value.
    expect(normalizeDomain("пример.рф")).toBe("xn--e1afmkfd.xn--p1ai");
    expect(normalizeDomain("xn--e1afmkfd.xn--p1ai")).toBe(
      "xn--e1afmkfd.xn--p1ai",
    );
  });

  it("returns null for non-hostname shapes", () => {
    expect(normalizeDomain("")).toBeNull();
    expect(normalizeDomain("localhost")).toBeNull(); // single label
    expect(normalizeDomain("1.2.3.4")).toBeNull(); // numeric TLD (IPv4)
    expect(normalizeDomain("10.0.0.255")).toBeNull();
    expect(normalizeDomain("1.2.3")).toBeNull(); // version string
  });
});

describe("buildOwnedDomainSet", () => {
  it("normalises, de-duplicates, and sorts", () => {
    const set = buildOwnedDomainSet([
      "B.Example",
      "a.example.",
      ".a.example",
      "invalid",
    ]);
    // "a.example." and ".a.example" collapse to one; "invalid" dropped.
    expect(set.normalisedSuffixes).toEqual(["a.example", "b.example"]);
  });

  it("yields an empty set for empty/all-invalid input", () => {
    expect(buildOwnedDomainSet([]).normalisedSuffixes).toEqual([]);
    expect(buildOwnedDomainSet(["localhost", ""]).normalisedSuffixes).toEqual(
      [],
    );
  });
});

describe("shouldRedactOwnedDomain", () => {
  const set = buildOwnedDomainSet(["domain.example"]);

  it("matches the suffix itself and any subdomain", () => {
    expect(shouldRedactOwnedDomain("domain.example", set)).toBe(true);
    expect(shouldRedactOwnedDomain("a.domain.example", set)).toBe(true);
    expect(shouldRedactOwnedDomain("a.b.domain.example", set)).toBe(true);
  });

  it("anchors on label boundaries (no substring match)", () => {
    expect(shouldRedactOwnedDomain("notdomain.example", set)).toBe(false);
    expect(shouldRedactOwnedDomain("domain.example.evil.test", set)).toBe(
      false,
    );
  });

  it("matches case-insensitively and via IDN folding", () => {
    expect(shouldRedactOwnedDomain("A.DOMAIN.EXAMPLE", set)).toBe(true);
    const idnSet = buildOwnedDomainSet(["пример.рф"]);
    // Both U-label and A-label forms redact when the suffix is owned.
    expect(shouldRedactOwnedDomain("sub.пример.рф", idnSet)).toBe(true);
    expect(shouldRedactOwnedDomain("sub.xn--e1afmkfd.xn--p1ai", idnSet)).toBe(
      true,
    );
  });

  it("an empty set matches nothing (external pass-through)", () => {
    expect(
      shouldRedactOwnedDomain("domain.example", EMPTY_OWNED_DOMAIN_SET),
    ).toBe(false);
    expect(
      shouldRedactOwnedDomain("anything.test", EMPTY_OWNED_DOMAIN_SET),
    ).toBe(false);
  });
});
