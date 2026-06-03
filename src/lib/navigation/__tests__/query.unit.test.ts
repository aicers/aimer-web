import { describe, expect, it } from "vitest";

import { mergeQuery } from "../query";

describe("mergeQuery", () => {
  it("adds a key while preserving existing params", () => {
    const result = mergeQuery("tz=UTC&lang=en", { scope: "c1,c2" });
    expect(result).toBe("lang=en&scope=c1%2Cc2&tz=UTC");
  });

  it("preserves legitimately-empty existing params", () => {
    const result = mergeQuery("tz=UTC&lang=&model=", { scope: "c1" });
    // `lang=` and `model=` are not in `updates`, so they survive.
    expect(result).toBe("lang=&model=&scope=c1&tz=UTC");
  });

  it("overwrites an existing key", () => {
    expect(mergeQuery("scope=all&tz=UTC", { scope: "c1" })).toBe(
      "scope=c1&tz=UTC",
    );
  });

  it("removes a key when the update value is null/undefined/empty", () => {
    expect(mergeQuery("scope=c1&tz=UTC", { scope: null })).toBe("tz=UTC");
    expect(mergeQuery("scope=c1&tz=UTC", { scope: undefined })).toBe("tz=UTC");
    expect(mergeQuery("scope=c1&tz=UTC", { scope: "" })).toBe("tz=UTC");
  });

  it("accepts a leading '?' and a URLSearchParams instance", () => {
    expect(mergeQuery("?tz=UTC", { scope: "c1" })).toBe("scope=c1&tz=UTC");
    const params = new URLSearchParams("tz=UTC");
    expect(mergeQuery(params, { scope: "c1" })).toBe("scope=c1&tz=UTC");
  });

  it("handles a null/empty current query", () => {
    expect(mergeQuery(null, { scope: "c1" })).toBe("scope=c1");
    expect(mergeQuery("", { scope: "c1" })).toBe("scope=c1");
    expect(mergeQuery(null, { scope: null })).toBe("");
  });
});
