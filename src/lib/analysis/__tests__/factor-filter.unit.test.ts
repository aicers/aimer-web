import { describe, expect, it } from "vitest";

import { filterFactors } from "../factor-filter";

describe("filterFactors", () => {
  it("keeps items that pass the shape filter and the cap", () => {
    const input = ["broad blast radius", "lateral movement potential"];
    const result = filterFactors(input, "severity");
    expect(result.kept).toEqual(input);
    expect(result.dropped).toEqual([]);
    expect(result.truncated).toEqual([]);
    expect(result.usedSentinel).toBe(false);
  });

  it("drops empty strings with reason 'empty'", () => {
    const result = filterFactors(["", "   ", "real item"], "severity");
    expect(result.kept).toEqual(["real item"]);
    expect(result.dropped).toEqual([
      { item: "", reason: "empty" },
      { item: "   ", reason: "empty" },
    ]);
    expect(result.usedSentinel).toBe(false);
  });

  it("80-char boundary: exactly 80 chars kept, 81 dropped as 'oversized'", () => {
    const at80 = "x".repeat(80);
    const at81 = "x".repeat(81);
    const result = filterFactors([at80, at81], "severity");
    expect(result.kept).toEqual([at80]);
    expect(result.dropped).toEqual([{ item: at81, reason: "oversized" }]);
  });

  it("drops items starting with 'The ' or 'This '", () => {
    const result = filterFactors(
      [
        "The attacker moved laterally",
        "This event involves PowerShell",
        "Their pattern matches APT",
      ],
      "likelihood",
    );
    expect(result.kept).toEqual(["Their pattern matches APT"]);
    expect(result.dropped).toEqual([
      { item: "The attacker moved laterally", reason: "sentence_start" },
      { item: "This event involves PowerShell", reason: "sentence_start" },
    ]);
  });

  it("caps at 5 — overflow lands in truncated, not dropped", () => {
    const input = [
      "factor 1",
      "factor 2",
      "factor 3",
      "factor 4",
      "factor 5",
      "factor 6",
      "factor 7",
    ];
    const result = filterFactors(input, "severity");
    expect(result.kept).toEqual(input.slice(0, 5));
    expect(result.truncated).toEqual(["factor 6", "factor 7"]);
    expect(result.dropped).toEqual([]);
    expect(result.usedSentinel).toBe(false);
  });

  it("sentinel recovery fires when every input is filtered out", () => {
    const result = filterFactors(
      ["The first reason", "This second reason", ""],
      "severity",
    );
    expect(result.kept).toEqual(["insufficient evidence"]);
    expect(result.usedSentinel).toBe(true);
    expect(result.dropped).toEqual([
      { item: "The first reason", reason: "sentence_start" },
      { item: "This second reason", reason: "sentence_start" },
      { item: "", reason: "empty" },
    ]);
  });

  it("preserves input order across both kept and dropped", () => {
    const result = filterFactors(["a", "", "b", "The c", "d"], "likelihood");
    expect(result.kept).toEqual(["a", "b", "d"]);
    expect(result.dropped).toEqual([
      { item: "", reason: "empty" },
      { item: "The c", reason: "sentence_start" },
    ]);
  });

  it("returns an empty truncated array when survivors are exactly 5", () => {
    const input = ["a", "b", "c", "d", "e"];
    const result = filterFactors(input, "severity");
    expect(result.kept).toEqual(input);
    expect(result.truncated).toEqual([]);
  });

  it("empty input → sentinel recovery", () => {
    const result = filterFactors([], "severity");
    expect(result.kept).toEqual(["insufficient evidence"]);
    expect(result.usedSentinel).toBe(true);
    expect(result.dropped).toEqual([]);
    expect(result.truncated).toEqual([]);
  });
});
