import { describe, expect, it } from "vitest";

import { normalizeScope, SCOPE_ALL, scopeRedirectTarget } from "../scope";

const ACCESSIBLE = ["c3", "c1", "c2"];

describe("normalizeScope", () => {
  it("treats an absent param as the all-scope (sorted accessible set)", () => {
    const scope = normalizeScope(null, ACCESSIBLE);
    expect(scope.isAll).toBe(true);
    expect(scope.canonical).toBe(SCOPE_ALL);
    expect(scope.customerIds).toEqual(["c1", "c2", "c3"]);

    expect(normalizeScope(undefined, ACCESSIBLE)).toEqual(scope);
  });

  it("treats an explicit/empty/whitespace 'all' value as the all-scope", () => {
    for (const raw of ["all", "ALL", " all ", "", "   "]) {
      const scope = normalizeScope(raw, ACCESSIBLE);
      expect(scope.isAll).toBe(true);
      expect(scope.canonical).toBe(SCOPE_ALL);
      expect(scope.customerIds).toEqual(["c1", "c2", "c3"]);
    }
  });

  it("parses a comma list into a sorted, deduped subset", () => {
    const scope = normalizeScope("c2, c1", ACCESSIBLE);
    expect(scope.isAll).toBe(false);
    expect(scope.customerIds).toEqual(["c1", "c2"]);
    expect(scope.canonical).toBe("c1,c2");
  });

  it("dedupes duplicate ids", () => {
    const scope = normalizeScope("c2,c2,c1", ACCESSIBLE);
    expect(scope.customerIds).toEqual(["c1", "c2"]);
    expect(scope.canonical).toBe("c1,c2");
  });

  it("drops ids the caller cannot access", () => {
    const scope = normalizeScope("c2,cX,c9", ACCESSIBLE);
    expect(scope.isAll).toBe(false);
    expect(scope.customerIds).toEqual(["c2"]);
    expect(scope.canonical).toBe("c2");
  });

  it("collapses an all-inaccessible value to the all-scope", () => {
    const scope = normalizeScope("cX,cY", ACCESSIBLE);
    expect(scope.isAll).toBe(true);
    expect(scope.canonical).toBe(SCOPE_ALL);
  });

  it("collapses garbled input to the all-scope", () => {
    const scope = normalizeScope(",, , ,", ACCESSIBLE);
    expect(scope.isAll).toBe(true);
    expect(scope.canonical).toBe(SCOPE_ALL);
  });

  it("collapses a subset covering the entire accessible set to all", () => {
    const scope = normalizeScope("c1,c2,c3", ACCESSIBLE);
    expect(scope.isAll).toBe(true);
    expect(scope.canonical).toBe(SCOPE_ALL);
  });

  it("collapses to all when the accessible set is empty", () => {
    const scope = normalizeScope("c1,c2", []);
    expect(scope.isAll).toBe(true);
    expect(scope.customerIds).toEqual([]);
    expect(scope.canonical).toBe(SCOPE_ALL);
  });
});

describe("scopeRedirectTarget", () => {
  it("does not redirect when the param is absent", () => {
    expect(scopeRedirectTarget(null, ACCESSIBLE)).toBeNull();
    expect(scopeRedirectTarget(undefined, ACCESSIBLE)).toBeNull();
  });

  it("does not redirect an already-canonical value", () => {
    expect(scopeRedirectTarget("all", ACCESSIBLE)).toBeNull();
    expect(scopeRedirectTarget("c1,c2", ACCESSIBLE)).toBeNull();
  });

  it("redirects unsorted / duplicated lists to the sorted canonical form", () => {
    expect(scopeRedirectTarget("c2,c1", ACCESSIBLE)).toBe("c1,c2");
    expect(scopeRedirectTarget("c1,c1", ACCESSIBLE)).toBe("c1");
  });

  it("redirects a list with inaccessible ids to the surviving subset", () => {
    expect(scopeRedirectTarget("c2,cX", ACCESSIBLE)).toBe("c2");
  });

  it("redirects garbled / all-inaccessible / full-set values to 'all'", () => {
    expect(scopeRedirectTarget("garbage", ACCESSIBLE)).toBe(SCOPE_ALL);
    expect(scopeRedirectTarget("cX,cY", ACCESSIBLE)).toBe(SCOPE_ALL);
    expect(scopeRedirectTarget("c1,c2,c3", ACCESSIBLE)).toBe(SCOPE_ALL);
    expect(scopeRedirectTarget("ALL", ACCESSIBLE)).toBe(SCOPE_ALL);
  });
});
