import { join } from "node:path";
import type { Pool } from "pg";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

vi.mock("server-only", () => ({}));

import {
  claimItem,
  createRun,
  finalizeRun,
  getRun,
  recordItemResult,
  requestCancel,
} from "../../analysis/event-leaf-backfill-store";
import type { RegenerateEventOutcome } from "../../analysis/regenerate-event";
import {
  closeAdminPool,
  createTestDatabase,
  dropTestDatabase,
  hasPostgres,
} from "../../db/__tests__/db-test-helpers";
import { runMigrations } from "../../db/migrate";
import {
  type EventBackfillDeps,
  runEventBackfillTickOnce,
} from "../event-backfill-worker";

const MIGRATIONS_DIR = join(process.cwd(), "migrations", "auth");
const LOCK_ID = 1470;

const TARGET = { lang: "ENGLISH", modelName: "openai", model: "gpt-5.5" };
const WINDOW = {
  windowStart: new Date("2026-06-01T00:00:00.000Z"),
  windowEnd: new Date("2026-06-08T00:00:00.000Z"),
};

/**
 * A fake customer pool. `loadUniverse` (createRun) sees the configured
 * universe rows; `hasTargetVariantLeaf` (the worker idempotency re-check)
 * sees `presentKeys`.
 */
function fakeCustomerPool(opts: {
  universe: Array<{
    aice_id: string;
    event_key: string;
    already_current: boolean;
    source_present: boolean;
  }>;
  presentKeys?: Set<string>;
}): Pool {
  return {
    // biome-ignore lint/suspicious/noExplicitAny: minimal test double
    query: async (sql: string, params?: any[]): Promise<any> => {
      if (sql.includes("latest_baseline")) {
        return {
          rows: opts.universe.map((u) => ({
            ...u,
            event_time: "2026-06-05T00:00:00.000Z",
          })),
        };
      }
      if (sql.includes("AS present")) {
        const key = `${params?.[0]}:${params?.[1]}`;
        return { rows: [{ present: opts.presentKeys?.has(key) ?? false }] };
      }
      return { rows: [] };
    },
    // biome-ignore lint/suspicious/noExplicitAny: minimal test double
  } as any;
}

describe.skipIf(!hasPostgres)("event backfill worker (DB)", () => {
  let pool: Pool;
  let dbName: string;

  async function freshCustomer(key: string): Promise<string> {
    const r = await pool.query<{ id: string }>(
      `INSERT INTO customers (external_key, name, status)
       VALUES ($1, 'C', 'active') RETURNING id`,
      [key],
    );
    return r.rows[0].id;
  }

  function deps(
    over: Partial<EventBackfillDeps> & { customerPool: Pool },
  ): EventBackfillDeps {
    return {
      authPool: pool,
      getCustomerPool: () => over.customerPool,
      regenerate:
        over.regenerate ??
        (async () => ({
          kind: "reanalyzed",
          generation: 2,
        })),
      batchSize: over.batchSize ?? 100,
      now: over.now ?? (() => new Date("2026-06-08T00:00:00.000Z")),
    };
  }

  beforeAll(async () => {
    const result = await createTestDatabase("event_backfill", "auth");
    pool = result.pool;
    dbName = result.dbName;
    await pool.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'aimer_auth') THEN
          CREATE ROLE aimer_auth LOGIN PASSWORD 'changeme';
        END IF;
      END $$
    `);
    await runMigrations(pool, MIGRATIONS_DIR, LOCK_ID);
  });

  // `claimRun` picks the globally-oldest active run, so isolate each test
  // from runs left active by earlier tests.
  beforeEach(async () => {
    await pool.query(`DELETE FROM event_leaf_backfill_runs`);
  });

  afterAll(async () => {
    await dropTestDatabase(dbName, pool);
    await closeAdminPool();
  });

  async function makeRun(
    cust: string,
    customerPool: Pool,
    maxItems: number | null = null,
  ): Promise<string> {
    const client = await pool.connect();
    try {
      const { run } = await createRun(client, customerPool, {
        customerId: cust,
        target: TARGET,
        windowDays: 7,
        window: WINDOW,
        maxItems,
        createdBy: "00000000-0000-0000-0000-0000000000aa",
      });
      return run.id;
    } finally {
      client.release();
    }
  }

  it("materializes only work candidates and seeds categorized counts", async () => {
    const cust = await freshCustomer("ebf-mat");
    const cp = fakeCustomerPool({
      universe: [
        {
          aice_id: "a",
          event_key: "1",
          already_current: true,
          source_present: true,
        },
        {
          aice_id: "a",
          event_key: "2",
          already_current: false,
          source_present: true,
        },
        {
          aice_id: "a",
          event_key: "3",
          already_current: false,
          source_present: false,
        },
      ],
    });
    const runId = await makeRun(cust, cp);
    const run = await getRun(pool, cust, runId);
    expect(run?.totalUniverse).toBe(3);
    expect(run?.alreadyCurrentCount).toBe(1);
    expect(run?.sourceUnavailableCount).toBe(1);
    const items = await pool.query(
      `SELECT status FROM event_leaf_backfill_items WHERE run_id = $1`,
      [runId],
    );
    // Only the single work candidate (a/2) is materialized.
    expect(items.rows).toHaveLength(1);
    expect(items.rows[0].status).toBe("pending");
  });

  it("drains pending items via the helper and completes", async () => {
    const cust = await freshCustomer("ebf-drain");
    const cp = fakeCustomerPool({
      universe: [
        {
          aice_id: "a",
          event_key: "10",
          already_current: false,
          source_present: true,
        },
        {
          aice_id: "a",
          event_key: "11",
          already_current: false,
          source_present: true,
        },
      ],
    });
    const runId = await makeRun(cust, cp);
    const result = await runEventBackfillTickOnce(deps({ customerPool: cp }));
    expect(result.runId).toBe(runId);
    expect(result.processed).toBe(2);
    expect(result.completed).toBe(true);
    const run = await getRun(pool, cust, runId);
    expect(run?.status).toBe("completed");
    expect(run?.reanalyzedCount).toBe(2);
  });

  it("categorizes failed and source_unavailable distinctly (no silent caps)", async () => {
    const cust = await freshCustomer("ebf-cat");
    const cp = fakeCustomerPool({
      universe: [
        {
          aice_id: "a",
          event_key: "20",
          already_current: false,
          source_present: true,
        },
        {
          aice_id: "a",
          event_key: "21",
          already_current: false,
          source_present: true,
        },
        {
          aice_id: "a",
          event_key: "22",
          already_current: false,
          source_present: true,
        },
      ],
    });
    const runId = await makeRun(cust, cp);
    const outcomes: Record<string, RegenerateEventOutcome> = {
      "20": { kind: "reanalyzed", generation: 2 },
      "21": { kind: "source_unavailable" },
      "22": { kind: "error", errorCode: "aimer_unavailable", message: "boom" },
    };
    await runEventBackfillTickOnce(
      deps({
        customerPool: cp,
        regenerate: async ({ item }) => outcomes[item.eventKey],
      }),
    );
    const run = await getRun(pool, cust, runId);
    expect(run?.reanalyzedCount).toBe(1);
    expect(run?.sourceUnavailableCount).toBe(1);
    expect(run?.failedCount).toBe(1);
    expect(run?.status).toBe("completed");
    const failed = await pool.query(
      `SELECT error FROM event_leaf_backfill_items
        WHERE run_id = $1 AND status = 'failed'`,
      [runId],
    );
    expect(failed.rows[0].error).toContain("aimer_unavailable");
  });

  it("skips an item that became already_current since materialization", async () => {
    const cust = await freshCustomer("ebf-idem");
    const cp = fakeCustomerPool({
      universe: [
        {
          aice_id: "a",
          event_key: "30",
          already_current: false,
          source_present: true,
        },
      ],
      presentKeys: new Set(["a:30"]),
    });
    const runId = await makeRun(cust, cp);
    let regenerateCalls = 0;
    await runEventBackfillTickOnce(
      deps({
        customerPool: cp,
        regenerate: async () => {
          regenerateCalls += 1;
          return { kind: "reanalyzed", generation: 2 };
        },
      }),
    );
    expect(regenerateCalls).toBe(0);
    const run = await getRun(pool, cust, runId);
    expect(run?.alreadyCurrentCount).toBe(1);
    expect(run?.reanalyzedCount).toBe(0);
  });

  it("self-paces: one batch per tick, resuming across ticks", async () => {
    const cust = await freshCustomer("ebf-pace");
    const cp = fakeCustomerPool({
      universe: [
        {
          aice_id: "a",
          event_key: "40",
          already_current: false,
          source_present: true,
        },
        {
          aice_id: "a",
          event_key: "41",
          already_current: false,
          source_present: true,
        },
        {
          aice_id: "a",
          event_key: "42",
          already_current: false,
          source_present: true,
        },
      ],
    });
    await makeRun(cust, cp);
    const r1 = await runEventBackfillTickOnce(
      deps({ customerPool: cp, batchSize: 2 }),
    );
    expect(r1.processed).toBe(2);
    expect(r1.completed).toBe(false);
    const r2 = await runEventBackfillTickOnce(
      deps({ customerPool: cp, batchSize: 2 }),
    );
    expect(r2.processed).toBe(1);
    expect(r2.completed).toBe(true);
  });

  it("cancels a still-pending run immediately, before any worker pickup", async () => {
    const cust = await freshCustomer("ebf-cancel-pending");
    const cp = fakeCustomerPool({
      universe: [
        {
          aice_id: "a",
          event_key: "48",
          already_current: false,
          source_present: true,
        },
      ],
    });
    const runId = await makeRun(cust, cp);
    const updated = await requestCancel(
      pool,
      cust,
      runId,
      "2026-06-08T00:00:00.000Z",
    );
    expect(updated?.status).toBe("cancelled");
    // The worker then finds no active run to claim.
    const result = await runEventBackfillTickOnce(deps({ customerPool: cp }));
    expect(result.claimed).toBe(false);
  });

  it("observes a cancel request mid-run and finalizes cancelled", async () => {
    const cust = await freshCustomer("ebf-cancel");
    const cp = fakeCustomerPool({
      universe: [
        {
          aice_id: "a",
          event_key: "50",
          already_current: false,
          source_present: true,
        },
        {
          aice_id: "a",
          event_key: "51",
          already_current: false,
          source_present: true,
        },
      ],
    });
    const runId = await makeRun(cust, cp);
    // First tick (batch 1) leaves the run RUNNING with a pending item.
    const r1 = await runEventBackfillTickOnce(
      deps({ customerPool: cp, batchSize: 1 }),
    );
    expect(r1.completed).toBe(false);
    // Cancelling a running run sets the flag but does not finalize it.
    const updated = await requestCancel(
      pool,
      cust,
      runId,
      "2026-06-08T00:00:00.000Z",
    );
    expect(updated?.status).toBe("running");
    // Next tick observes the flag and finalizes cancelled.
    const r2 = await runEventBackfillTickOnce(deps({ customerPool: cp }));
    expect(r2.cancelled).toBe(true);
    const run = await getRun(pool, cust, runId);
    expect(run?.status).toBe("cancelled");
  });

  it("honours a cancel requested during the last item as cancelled", async () => {
    // A cancel submitted DURING the last item's model call (after the
    // per-item cancel check) must finalize the run `cancelled`, not silently
    // report it `completed`.
    const cust = await freshCustomer("ebf-cancel-last");
    const cp = fakeCustomerPool({
      universe: [
        {
          aice_id: "a",
          event_key: "60",
          already_current: false,
          source_present: true,
        },
      ],
    });
    const runId = await makeRun(cust, cp);
    const result = await runEventBackfillTickOnce(
      deps({
        customerPool: cp,
        regenerate: async () => {
          // Operator cancels while the last item is in flight.
          await requestCancel(pool, cust, runId, "2026-06-08T00:00:00.000Z");
          return { kind: "reanalyzed", generation: 2 };
        },
      }),
    );
    expect(result.cancelled).toBe(true);
    expect(result.completed).toBe(false);
    const run = await getRun(pool, cust, runId);
    expect(run?.status).toBe("cancelled");
    // The in-flight item's model call already happened, so it is recorded.
    expect(run?.reanalyzedCount).toBe(1);
  });

  it("status-guards finalize: completed cannot overwrite cancelled", async () => {
    // finalizeRun is guarded on a non-terminal status, so a late `completed`
    // from one replica cannot clobber a `cancelled` already written by
    // another.
    const cust = await freshCustomer("ebf-guard");
    const cp = fakeCustomerPool({
      universe: [
        {
          aice_id: "a",
          event_key: "65",
          already_current: false,
          source_present: true,
        },
      ],
    });
    const runId = await makeRun(cust, cp);
    const client = await pool.connect();
    try {
      expect(
        await finalizeRun(
          client,
          runId,
          "cancelled",
          "2026-06-08T00:00:00.000Z",
        ),
      ).toBe(true);
      // A later finalize against the now-terminal run is a no-op.
      expect(
        await finalizeRun(
          client,
          runId,
          "completed",
          "2026-06-08T00:01:00.000Z",
        ),
      ).toBe(false);
    } finally {
      client.release();
    }
    const run = await getRun(pool, cust, runId);
    expect(run?.status).toBe("cancelled");
  });

  it("does not re-analyze an item already claimed by a concurrent worker", async () => {
    // Simulate a second replica holding the only work item in `processing`
    // (fresh claim, not stale). This tick must NOT call the model for it,
    // must NOT double-count, and must NOT finalize the run as completed.
    const cust = await freshCustomer("ebf-concurrent");
    const cp = fakeCustomerPool({
      universe: [
        {
          aice_id: "a",
          event_key: "70",
          already_current: false,
          source_present: true,
        },
      ],
    });
    const runId = await makeRun(cust, cp);
    await pool.query(
      `UPDATE event_leaf_backfill_items
          SET status = 'processing', updated_at = $2::timestamptz
        WHERE run_id = $1`,
      [runId, "2026-06-08T00:00:00.000Z"],
    );
    let regenerateCalls = 0;
    const result = await runEventBackfillTickOnce(
      deps({
        customerPool: cp,
        regenerate: async () => {
          regenerateCalls += 1;
          return { kind: "reanalyzed", generation: 2 };
        },
      }),
    );
    expect(regenerateCalls).toBe(0);
    expect(result.completed).toBe(false);
    const run = await getRun(pool, cust, runId);
    expect(run?.status).toBe("running");
    expect(run?.reanalyzedCount).toBe(0);
  });

  it("reclaims a stale processing item and re-runs it", async () => {
    // An item left `processing` by a crashed worker (claim older than the
    // lease) is reset to pending and processed on the next tick.
    const cust = await freshCustomer("ebf-reclaim");
    const cp = fakeCustomerPool({
      universe: [
        {
          aice_id: "a",
          event_key: "80",
          already_current: false,
          source_present: true,
        },
      ],
    });
    const runId = await makeRun(cust, cp);
    // Stale claim: updated_at well before now - lease (15 min).
    await pool.query(
      `UPDATE event_leaf_backfill_items
          SET status = 'processing', updated_at = $2::timestamptz
        WHERE run_id = $1`,
      [runId, "2026-06-07T00:00:00.000Z"],
    );
    let regenerateCalls = 0;
    const result = await runEventBackfillTickOnce(
      deps({
        customerPool: cp,
        regenerate: async () => {
          regenerateCalls += 1;
          return { kind: "reanalyzed", generation: 2 };
        },
      }),
    );
    expect(regenerateCalls).toBe(1);
    expect(result.completed).toBe(true);
    const run = await getRun(pool, cust, runId);
    expect(run?.reanalyzedCount).toBe(1);
    expect(run?.status).toBe("completed");
  });

  it("records a terminal item once: a duplicate record is a no-op", async () => {
    // recordItemResult only bumps the run aggregate when it transitions a
    // `processing` item, so a second worker recording the same item cannot
    // double-count.
    const cust = await freshCustomer("ebf-once");
    const cp = fakeCustomerPool({
      universe: [
        {
          aice_id: "a",
          event_key: "90",
          already_current: false,
          source_present: true,
        },
      ],
    });
    const runId = await makeRun(cust, cp);
    const item = { aiceId: "a", eventKey: "90" };
    const client = await pool.connect();
    try {
      const claimed = await claimItem(
        client,
        runId,
        item,
        "2026-06-08T00:00:00.000Z",
      );
      expect(claimed).toBe(true);
      // A second claim loses — the item is no longer pending.
      expect(
        await claimItem(client, runId, item, "2026-06-08T00:00:00.000Z"),
      ).toBe(false);
      const first = await recordItemResult(
        client,
        runId,
        item,
        "reanalyzed",
        "2026-06-08T00:00:00.000Z",
      );
      const second = await recordItemResult(
        client,
        runId,
        item,
        "reanalyzed",
        "2026-06-08T00:00:00.000Z",
      );
      expect(first).toBe(true);
      expect(second).toBe(false);
    } finally {
      client.release();
    }
    const run = await getRun(pool, cust, runId);
    expect(run?.reanalyzedCount).toBe(1);
  });

  it("returns the existing active run instead of duplicating", async () => {
    const cust = await freshCustomer("ebf-dup");
    const cp = fakeCustomerPool({
      universe: [
        {
          aice_id: "a",
          event_key: "60",
          already_current: false,
          source_present: true,
        },
      ],
    });
    const id1 = await makeRun(cust, cp);
    const id2 = await makeRun(cust, cp);
    expect(id2).toBe(id1);
  });
});
