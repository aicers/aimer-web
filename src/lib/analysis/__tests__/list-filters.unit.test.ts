// WS3 (#392) — list filter parsing.

import { describe, expect, it } from "vitest";
import {
  buildListQuery,
  parseListFilters,
  parsePriorityTier,
  parseTimeWindow,
  windowSince,
} from "../list-filters";

const NOW = Date.UTC(2026, 4, 27, 12, 0, 0); // 2026-05-27T12:00:00Z

describe("parsePriorityTier", () => {
  it("accepts the four valid tiers", () => {
    expect(parsePriorityTier("CRITICAL")).toBe("CRITICAL");
    expect(parsePriorityTier("LOW")).toBe("LOW");
  });
  it("rejects unknown / lowercase / empty values", () => {
    expect(parsePriorityTier("critical")).toBeNull();
    expect(parsePriorityTier("URGENT")).toBeNull();
    expect(parsePriorityTier(undefined)).toBeNull();
  });
});

describe("parseTimeWindow", () => {
  it("accepts known windows", () => {
    expect(parseTimeWindow("24h")).toBe("24h");
    expect(parseTimeWindow("30d")).toBe("30d");
  });
  it("falls back to 'all' for unknown / missing values", () => {
    expect(parseTimeWindow("1y")).toBe("all");
    expect(parseTimeWindow(undefined)).toBe("all");
  });
});

describe("windowSince", () => {
  it("returns null for 'all'", () => {
    expect(windowSince("all", NOW)).toBeNull();
  });
  it("subtracts the window from now", () => {
    expect(windowSince("24h", NOW)?.toISOString()).toBe(
      "2026-05-26T12:00:00.000Z",
    );
    expect(windowSince("7d", NOW)?.toISOString()).toBe(
      "2026-05-20T12:00:00.000Z",
    );
  });
});

describe("parseListFilters", () => {
  it("combines priority + window into resolved filters", () => {
    const f = parseListFilters({ priority: "HIGH", window: "7d" }, NOW);
    expect(f.priorityTier).toBe("HIGH");
    expect(f.window).toBe("7d");
    expect(f.since?.toISOString()).toBe("2026-05-20T12:00:00.000Z");
  });
  it("defaults to no priority filter and all-time", () => {
    const f = parseListFilters({}, NOW);
    expect(f.priorityTier).toBeNull();
    expect(f.window).toBe("all");
    expect(f.since).toBeNull();
  });
});

describe("buildListQuery", () => {
  it("omits defaults for the canonical bare first page", () => {
    expect(buildListQuery({ priorityTier: null, window: "all" })).toBe("");
  });
  it("encodes priority, window, and cursor", () => {
    expect(
      buildListQuery({
        priorityTier: "CRITICAL",
        window: "24h",
        cursor: "abc",
      }),
    ).toBe("?priority=CRITICAL&window=24h&cursor=abc");
  });
  it("includes the cursor without filters", () => {
    expect(
      buildListQuery({ priorityTier: null, window: "all", cursor: "xyz" }),
    ).toBe("?cursor=xyz");
  });
});
