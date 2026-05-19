import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

vi.mock("../../db/customer-db", () => ({
  customerTransitKeyName: (id: string) => `customer-${id}`,
  customerDbUrl: (template: string, id: string) =>
    template.replace(/\/[^/?]+(\?|$)/, `/customer_${id.replace(/-/g, "")}$1`),
  getCustomerOwnerTemplateUrl: () =>
    "postgres://owner:pass@localhost:5432/template1",
}));

import type { Pool, QueryResult } from "pg";
import type { RotationDeps } from "../kek-rotation";
import { rotateAllKeks } from "../kek-rotation";

const transitConfig = { addr: "http://localhost:8200", token: "test-token" };

function createDeps(overrides?: Partial<RotationDeps>): RotationDeps {
  return {
    transitConfig,
    ownerTemplateUrl: "postgres://owner:pass@localhost:5432/template1",
    rotateKey: vi.fn().mockResolvedValue(undefined),
    rewrapDek: vi
      .fn()
      .mockImplementation((_c, _k, wrapped: string) =>
        Promise.resolve(wrapped.replace("v1", "v2")),
      ),
    connectCustomerDb: vi.fn().mockResolvedValue({
      query: vi.fn().mockResolvedValue({ rows: [] }),
      end: vi.fn().mockResolvedValue(undefined),
    }),
    clearCache: vi.fn(),
    ...overrides,
  };
}

function mockPool(
  queryImpl: (sql: string, params?: unknown[]) => Partial<QueryResult>,
) {
  return {
    query: vi.fn((sql: string, params?: unknown[]) =>
      Promise.resolve(queryImpl(sql, params)),
    ),
  } as unknown as Pool;
}

describe("rotateAllKeks", () => {
  it("rotates customer keys and rewraps DEKs", async () => {
    const deps = createDeps();
    const pool = mockPool((sql) => {
      if (sql.includes("FROM customers"))
        return {
          rows: [
            { id: "cust-1", wrapped_dek: "vault:v1:dek1" },
            { id: "cust-2", wrapped_dek: "vault:v1:dek2" },
          ],
        };
      return { rows: [] };
    });

    const result = await rotateAllKeks(pool, deps);

    expect(result.customersRotated).toBe(2);
    expect(result.customersErrored).toBe(0);
    expect(result.customerDeksRewrapped).toBe(2);
    expect(result.errors).toHaveLength(0);
    expect(deps.rotateKey).toHaveBeenCalledTimes(3); // 2 customers + staging
    expect(deps.rewrapDek).toHaveBeenCalledTimes(2);
    expect(deps.clearCache).toHaveBeenCalledOnce();
  });

  it("rewraps event_redaction_map rows in customer DBs", async () => {
    const mockClientQuery = vi.fn().mockImplementation((sql: string) => {
      if (typeof sql !== "string") return { rows: [] };
      const lowered = sql.toLowerCase();
      if (
        lowered.includes("from event_redaction_map") &&
        !lowered.includes("(aice_id, event_key) >")
      ) {
        // First batch — no cursor predicate.
        return {
          rows: [
            {
              aice_id: "aice-1",
              event_key: "10",
              wrapped_dek: "vault:v1:evtdek1",
            },
            {
              aice_id: "aice-1",
              event_key: "11",
              wrapped_dek: "vault:v1:evtdek2",
            },
          ],
        };
      }
      // Subsequent batch is empty -> loop terminates.
      if (lowered.includes("from event_redaction_map")) {
        return { rows: [] };
      }
      return { rows: [] };
    });
    const deps = createDeps({
      connectCustomerDb: vi.fn().mockResolvedValue({
        query: mockClientQuery,
        end: vi.fn().mockResolvedValue(undefined),
      }),
    });
    const pool = mockPool((sql) => {
      if (sql.includes("FROM customers"))
        return { rows: [{ id: "cust-1", wrapped_dek: "vault:v1:dek1" }] };
      return { rows: [] };
    });

    const result = await rotateAllKeks(pool, deps);

    expect(result.eventDeksRewrapped).toBe(2);
    expect(deps.rewrapDek).toHaveBeenCalledTimes(3); // 1 customer + 2 events

    // Verify each row's UPDATE uses the composite (aice_id, event_key) key.
    const updateCalls = mockClientQuery.mock.calls.filter(
      (c) =>
        typeof c[0] === "string" &&
        c[0].toLowerCase().includes("update event_redaction_map"),
    );
    expect(updateCalls.length).toBe(2);
    for (const call of updateCalls) {
      const params = call[1] as unknown[];
      // Params: [newWrapped, aice_id, event_key]
      expect(params).toHaveLength(3);
      expect(typeof params[1]).toBe("string");
      expect(typeof params[2]).toBe("string");
    }

    // Per-batch BEGIN/COMMIT is required — without it FOR UPDATE
    // releases the row lock immediately on autocommit, defeating
    // the ingestion-vs-rotation race guard.
    const beginCalls = mockClientQuery.mock.calls.filter(
      (c) => c[0] === "BEGIN",
    );
    const commitCalls = mockClientQuery.mock.calls.filter(
      (c) => c[0] === "COMMIT",
    );
    expect(beginCalls.length).toBeGreaterThan(0);
    expect(commitCalls.length).toBe(beginCalls.length);
  });

  it("rewraps staged_event_payloads", async () => {
    const deps = createDeps();
    const pool = mockPool((sql) => {
      if (sql.includes("FROM staged_event_payloads"))
        return {
          rows: [
            { id: "staged-1", wrapped_dek: "vault:v1:stageddek1" },
            { id: "staged-2", wrapped_dek: "vault:v1:stageddek2" },
          ],
        };
      return { rows: [] };
    });

    const result = await rotateAllKeks(pool, deps);

    expect(result.stagingDeksRewrapped).toBe(2);
    expect(deps.rotateKey).toHaveBeenCalledWith(
      transitConfig,
      "staging-events",
    );
  });

  it("continues on per-customer failure and collects errors", async () => {
    const rotateKey = vi
      .fn()
      .mockResolvedValueOnce(undefined) // cust-ok
      .mockRejectedValueOnce(new Error("Transit unreachable")) // cust-fail
      .mockResolvedValueOnce(undefined); // staging
    const deps = createDeps({ rotateKey });
    const pool = mockPool((sql) => {
      if (sql.includes("FROM customers"))
        return {
          rows: [
            { id: "cust-ok", wrapped_dek: "vault:v1:ok" },
            { id: "cust-fail", wrapped_dek: "vault:v1:fail" },
          ],
        };
      return { rows: [] };
    });

    const result = await rotateAllKeks(pool, deps);

    expect(result.customersRotated).toBe(1);
    expect(result.customersErrored).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].customerId).toBe("cust-fail");
    expect(result.errors[0].error).toContain("Transit unreachable");
  });

  it("handles customers with null wrapped_dek", async () => {
    const deps = createDeps();
    const pool = mockPool((sql) => {
      if (sql.includes("FROM customers"))
        return { rows: [{ id: "cust-1", wrapped_dek: null }] };
      return { rows: [] };
    });

    const result = await rotateAllKeks(pool, deps);

    expect(result.customersRotated).toBe(1);
    expect(result.customerDeksRewrapped).toBe(0);
    expect(deps.rewrapDek).not.toHaveBeenCalled();
  });
});
