// Unit tests for the cross-customer overview aggregator (WS2, #391).
//
// Two layers:
//   1. Pure helpers — ranking (integer tier rank, not lexicographic text),
//      top-K cap, the permission intersection, and the partial-failure-
//      tolerant fan-out merge.
//   2. The `loadCrossCustomerOverview` wiring — auth/bridge mapping, the
//      per-surface permission gate (a customer in scope but lacking the
//      surface permission contributes neither rows nor counts), cross-
//      customer merge ordering, and graceful degradation when one customer
//      DB is unreachable.
//
// The SQL-level guarantees (canonical `superseded_at IS NULL` + latest-
// generation dedup, and the `story_analysis_state` lifecycle exclusion) run
// in Postgres and are covered by `cross-customer-overview.db.test.ts`; here
// the pools are faked so the merge/permission/auth surface is exercised in
// isolation.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mockGetAuthCookie = vi.fn();
const mockVerifyJwtFull = vi.fn();
const mockGetSessionPolicy = vi.fn();
const mockValidateSession = vi.fn();
const mockListDetailed = vi.fn();
const mockGetCustomerRuntimePool = vi.fn();

vi.mock("@/lib/auth/cookies", () => ({
  getAuthCookie: (...args: unknown[]) => mockGetAuthCookie(...args),
}));
vi.mock("@/lib/auth/jwt", () => ({
  verifyJwtFull: (...args: unknown[]) => mockVerifyJwtFull(...args),
}));
vi.mock("@/lib/auth/session-policy", () => ({
  getSessionPolicy: (...args: unknown[]) => mockGetSessionPolicy(...args),
}));
vi.mock("@/lib/auth/session-validator", () => ({
  validateSession: (...args: unknown[]) => mockValidateSession(...args),
}));
vi.mock("@/lib/auth/authorization", () => ({
  listAccessibleCustomersDetailed: (...args: unknown[]) =>
    mockListDetailed(...args),
}));
vi.mock("@/lib/db/client", () => ({
  getAuthPool: () => ({}),
  withTransaction: async (_pool: unknown, fn: (client: unknown) => unknown) =>
    fn({}),
}));
vi.mock("@/lib/db/customer-runtime-pool", () => ({
  getCustomerRuntimePool: (id: string) => mockGetCustomerRuntimePool(id),
}));

import {
  aggregateSurface,
  compareRisk,
  type EventOverviewRow,
  loadCrossCustomerOverview,
  permittedCustomers,
  rankAndCap,
} from "../cross-customer-overview";
import type { PriorityTier } from "../priority-tier";

// --- pure ranking helpers -------------------------------------------------

interface Key {
  tier: PriorityTier;
  severity: number;
  likelihood: number;
  recencyMs: number;
  id: string;
}
const k = (
  tier: PriorityTier,
  severity = 0,
  likelihood = 0,
  recencyMs = 0,
  id = "x",
): Key => ({ tier, severity, likelihood, recencyMs, id });

describe("compareRisk", () => {
  it("orders by integer tier rank, not lexicographic tier text", () => {
    // Lexicographically CRITICAL < HIGH < LOW < MEDIUM (backwards). The rank
    // must put CRITICAL first and LOW last.
    const tiers: PriorityTier[] = ["LOW", "CRITICAL", "MEDIUM", "HIGH"];
    const sorted = [...tiers]
      .map((t) => k(t))
      .sort(compareRisk)
      .map((x) => x.tier);
    expect(sorted).toEqual(["CRITICAL", "HIGH", "MEDIUM", "LOW"]);
  });

  it("breaks ties by severity, then likelihood, then recency desc, then id asc", () => {
    const rows = [
      k("HIGH", 0.5, 0.5, 100, "b"),
      k("HIGH", 0.5, 0.5, 100, "a"), // same except id → a before b
      k("HIGH", 0.5, 0.5, 200, "z"), // newer recency → first
      k("HIGH", 0.5, 0.9, 100, "m"), // higher likelihood → before the 0.5s
      k("HIGH", 0.9, 0.1, 100, "n"), // higher severity → before all 0.5s
    ];
    const order = [...rows].sort(compareRisk).map((x) => x.id);
    expect(order).toEqual(["n", "m", "z", "a", "b"]);
  });
});

describe("rankAndCap", () => {
  it("sorts high-risk first and caps to the limit", () => {
    const rows = [k("LOW"), k("CRITICAL"), k("MEDIUM"), k("HIGH")];
    const out = rankAndCap(rows, (r) => r, 2).map((r) => r.tier);
    expect(out).toEqual(["CRITICAL", "HIGH"]);
  });
});

// --- permission intersection ---------------------------------------------

const detailed = (
  id: string,
  permissions: string[],
): Parameters<typeof permittedCustomers>[0][number] => ({
  id,
  name: `Customer ${id}`,
  externalKey: `key-${id}`,
  role: "User",
  isAnalyst: false,
  permissions,
});

describe("permittedCustomers", () => {
  it("keeps only in-scope customers holding the surface permission", () => {
    const list = [
      detailed("c1", ["reports:read", "analyses:read"]),
      detailed("c2", ["analyses:read"]), // no reports:read
      detailed("c3", ["reports:read"]), // out of scope
    ];
    const scope = ["c1", "c2"]; // c3 excluded by scope
    const kept = permittedCustomers(list, scope, "reports:read").map(
      (c) => c.id,
    );
    expect(kept).toEqual(["c1"]); // c2 lacks reports:read, c3 out of scope
  });

  it("is access-only-insufficient: scope membership alone does not qualify", () => {
    const list = [detailed("c1", [])]; // accessible but zero grants
    expect(permittedCustomers(list, ["c1"], "analyses:read")).toEqual([]);
  });
});

// --- partial-failure fan-out ---------------------------------------------

describe("aggregateSurface", () => {
  const cust = (id: string) => detailed(id, []);
  const keyOf = (r: { tier: PriorityTier; id: string }): Key =>
    k(r.tier, 0, 0, 0, r.id);

  it("merges, ranks, and caps across customers", async () => {
    const result = await aggregateSurface(
      [cust("c1"), cust("c2")],
      async (c) =>
        c.id === "c1"
          ? { rows: [{ tier: "LOW" as const, id: "c1" }], total: 1 }
          : { rows: [{ tier: "CRITICAL" as const, id: "c2" }], total: 1 },
      keyOf,
      10,
    );
    expect(result.items.map((r) => r.tier)).toEqual(["CRITICAL", "LOW"]);
    expect(result.totalCount).toBe(2);
    expect(result.failedCustomers).toEqual([]);
  });

  it("degrades on one unreachable customer without zeroing counts", async () => {
    const result = await aggregateSurface(
      [cust("c1"), cust("c2")],
      async (c) => {
        if (c.id === "c2") throw new Error("ECONNREFUSED");
        return { rows: [{ tier: "HIGH" as const, id: "c1" }], total: 3 };
      },
      keyOf,
      10,
    );
    // c1 still contributes its rows and count; c2 surfaced as failed.
    expect(result.items.map((r) => r.id)).toEqual(["c1"]);
    expect(result.totalCount).toBe(3);
    expect(result.failedCustomers).toEqual([{ id: "c2", name: "Customer c2" }]);
  });
});

// --- loadCrossCustomerOverview wiring -------------------------------------

function armSession(opts?: {
  bridgeAiceId?: string | null;
  bridgeCustomerIds?: string[] | null;
}) {
  mockGetAuthCookie.mockResolvedValue("token");
  mockVerifyJwtFull.mockResolvedValue({ sub: "acc-1", sid: "sess-1" });
  mockGetSessionPolicy.mockResolvedValue({ general: {} });
  mockValidateSession.mockResolvedValue({
    bridgeAiceId: opts?.bridgeAiceId ?? null,
    bridgeCustomerIds: opts?.bridgeCustomerIds ?? null,
  });
}

// A fake per-customer pool whose `query` returns canned event rows. The SQL
// ORDER BY/LIMIT is not executed by the fake (that is the db test's job); the
// loader's app-level merge re-sorts the union.
function eventPool(
  rows: Array<{
    aice_id: string;
    event_key: string;
    priority_tier: PriorityTier;
    severity_score: number;
    likelihood_score: number;
    requested_at: Date;
    total_count: number;
  }>,
) {
  return {
    query: vi.fn().mockResolvedValue({
      rows: rows.map((r) => ({
        ...r,
        lang: "ENGLISH",
        model_name: "openai",
        model: "gpt-4o",
        total_count: String(r.total_count),
      })),
    }),
  };
}

const ev = (
  aice: string,
  key: string,
  tier: PriorityTier,
  total: number,
): Parameters<typeof eventPool>[0][number] => ({
  aice_id: aice,
  event_key: key,
  priority_tier: tier,
  severity_score: 0.5,
  likelihood_score: 0.5,
  requested_at: new Date("2026-06-01T00:00:00Z"),
  total_count: total,
});

describe("loadCrossCustomerOverview", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns unauthorized with no cookie", async () => {
    mockGetAuthCookie.mockResolvedValue(null);
    const out = await loadCrossCustomerOverview({
      scopeCustomerIds: ["c1"],
      surfaces: ["events"],
    });
    expect(out.kind).toBe("unauthorized");
  });

  it("short-circuits a bridge session", async () => {
    armSession({ bridgeCustomerIds: ["c1"] });
    const out = await loadCrossCustomerOverview({
      scopeCustomerIds: ["c1"],
      surfaces: ["events"],
    });
    expect(out.kind).toBe("bridge");
  });

  it("excludes a scope customer lacking the surface permission from rows and counts", async () => {
    armSession();
    mockListDetailed.mockResolvedValue([
      detailed("c1", ["analyses:read"]),
      detailed("c2", ["reports:read"]), // accessible, but NOT analyses:read
    ]);
    mockGetCustomerRuntimePool.mockImplementation((id: string) =>
      id === "c1"
        ? eventPool([ev("a1", "10", "HIGH", 1)])
        : eventPool([ev("a2", "20", "CRITICAL", 9)]),
    );

    const out = await loadCrossCustomerOverview({
      scopeCustomerIds: ["c1", "c2"],
      surfaces: ["events"],
    });
    expect(out.kind).toBe("ok");
    if (out.kind !== "ok") return;
    const events = out.events as {
      items: EventOverviewRow[];
      totalCount: number;
    };
    // c2 is never queried — its CRITICAL row and its count of 9 must not leak.
    expect(events.totalCount).toBe(1);
    expect(events.items.map((r) => r.customerId)).toEqual(["c1"]);
    expect(mockGetCustomerRuntimePool).toHaveBeenCalledWith("c1");
    expect(mockGetCustomerRuntimePool).not.toHaveBeenCalledWith("c2");
  });

  it("merges permitted customers high-risk first and sums their counts", async () => {
    armSession();
    mockListDetailed.mockResolvedValue([
      detailed("c1", ["analyses:read"]),
      detailed("c2", ["analyses:read"]),
    ]);
    mockGetCustomerRuntimePool.mockImplementation((id: string) =>
      id === "c1"
        ? eventPool([ev("a1", "10", "LOW", 2)])
        : eventPool([ev("a2", "20", "CRITICAL", 3)]),
    );

    const out = await loadCrossCustomerOverview({
      scopeCustomerIds: ["c1", "c2"],
      surfaces: ["events"],
    });
    if (out.kind !== "ok" || !out.events) throw new Error("expected ok");
    expect(out.events.items.map((r) => r.priorityTier)).toEqual([
      "CRITICAL",
      "LOW",
    ]);
    expect(out.events.totalCount).toBe(5); // 2 + 3
    expect(out.events.failedCustomers).toEqual([]);
  });

  it("degrades gracefully when one customer DB is unreachable", async () => {
    armSession();
    mockListDetailed.mockResolvedValue([
      detailed("c1", ["analyses:read"]),
      detailed("c2", ["analyses:read"]),
    ]);
    mockGetCustomerRuntimePool.mockImplementation((id: string) => {
      if (id === "c2") {
        return {
          query: vi.fn().mockRejectedValue(new Error("ECONNREFUSED")),
        };
      }
      return eventPool([ev("a1", "10", "HIGH", 4)]);
    });

    const out = await loadCrossCustomerOverview({
      scopeCustomerIds: ["c1", "c2"],
      surfaces: ["events"],
    });
    if (out.kind !== "ok" || !out.events) throw new Error("expected ok");
    expect(out.events.items.map((r) => r.customerId)).toEqual(["c1"]);
    expect(out.events.totalCount).toBe(4); // c2 excluded, not zeroed
    expect(out.events.failedCustomers).toEqual([
      { id: "c2", name: "Customer c2" },
    ]);
  });
});
