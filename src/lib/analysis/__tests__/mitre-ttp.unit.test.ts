import { describe, expect, it, vi } from "vitest";

// `mitre-ttp.ts` opens with `import "server-only"`, which is a sentinel
// shim Next.js installs to fail any client-bundle build that pulls a
// server module in. Vitest runs in Node and has no such bundler step,
// so the shim throws at module load. Mocking it to an empty module lets
// the unit test exercise the real validator.
vi.mock("server-only", () => ({}));

const { validateTtpTags } = await import("../mitre-ttp");

describe("validateTtpTags", () => {
  it("returns empty valid + dropped for an empty input", () => {
    const result = validateTtpTags([]);
    expect(result.valid).toEqual([]);
    expect(result.dropped).toEqual([]);
  });

  it("keeps a small fixture of confirmed-real IDs", () => {
    // T1078, T1110, and T1110.001 are stable Enterprise techniques that
    // appear in every recent MITRE bundle. If a refresh drops one of
    // them this test is the canary.
    const input = ["T1078", "T1110", "T1110.001"];
    const result = validateTtpTags(input);
    expect(result.valid).toEqual(input);
    expect(result.dropped).toEqual([]);
  });

  it("drops syntactically invalid IDs with reason invalid_format", () => {
    const cases = [
      "",
      "t1078",
      "T78",
      "T10780",
      "T1078.0001",
      "T1078.01",
      "T1078.",
      "1078",
      "T1078 ",
      "TA0001",
    ];
    const result = validateTtpTags(cases);
    expect(result.valid).toEqual([]);
    expect(result.dropped).toEqual(
      cases.map((id) => ({ id, reason: "invalid_format" })),
    );
  });

  it("drops syntactically valid but unknown IDs with reason not_in_vendored_mitre", () => {
    // Four-digit suffix `T9999` cannot exist in any current MITRE
    // release but matches the regex, so it must surface as the
    // not-in-vendor case rather than invalid_format.
    const input = ["T9999", "T9999.999"];
    const result = validateTtpTags(input);
    expect(result.valid).toEqual([]);
    expect(result.dropped).toEqual([
      { id: "T9999", reason: "not_in_vendored_mitre" },
      { id: "T9999.999", reason: "not_in_vendored_mitre" },
    ]);
  });

  it("preserves input order in the valid array (deterministic audit payload)", () => {
    const input = ["T1110.001", "T1078", "T1110"];
    const result = validateTtpTags(input);
    expect(result.valid).toEqual(["T1110.001", "T1078", "T1110"]);
  });

  it("interleaves valid and invalid inputs correctly", () => {
    const input = ["T1078", "bogus", "T9999", "T1110.001"];
    const result = validateTtpTags(input);
    expect(result.valid).toEqual(["T1078", "T1110.001"]);
    expect(result.dropped).toEqual([
      { id: "bogus", reason: "invalid_format" },
      { id: "T9999", reason: "not_in_vendored_mitre" },
    ]);
  });
});
