// #511 — group cost-preview combined recent event volume.
//
// Exercises the real trailing-window SQL behind `computeCombinedRecentEventVolume`
// against a migrated customer DB. The route unit test mocks the per-member
// query, so the window predicate itself is only covered here. The headline
// guard: a future-dated canonical baseline row must NOT inflate the count —
// the window is `[now - 30 days, now)`, bounded at both ends like the canonical
// report/reconcile windows.

import { join } from "node:path";
import type { Pool } from "pg";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";

vi.mock("server-only", () => ({}));

import {
  closeAdminPool,
  createTestDatabase,
  dropTestDatabase,
  hasPostgres,
} from "@/lib/db/__tests__/db-test-helpers";
import { runMigrations } from "@/lib/db/migrate";

const CUSTOMER_MIGRATIONS_DIR = join(process.cwd(), "migrations", "customer");
const CUSTOMER_LOCK_ID = 2637;

// `recentEventCount` resolves the per-member pool via getCustomerRuntimePool;
// point it at the single migrated test pool regardless of the id passed.
let testPool: Pool;
vi.mock("@/lib/db/customer-runtime-pool", () => ({
  getCustomerRuntimePool: () => testPool,
}));

const { computeCombinedRecentEventVolume } = await import("../cost-preview");

const MEMBER_A = "00000000-0000-0000-0000-0000000005a1";

// `eventTimeExpr` / `receivedAtExpr` are raw SQL timestamp expressions
// (e.g. `NOW() - INTERVAL '1 day'`) inlined directly — they are test-local
// constants, never user input. The window math must run relative to the DB's
// own NOW(), so it cannot be a bound parameter.
async function seedBaselineEvent(
  pool: Pool,
  eventKey: string,
  eventTimeExpr: string,
  receivedAtExpr: string,
  baselineVersion = "1",
): Promise<void> {
  await pool.query(
    `INSERT INTO baseline_event
       (baseline_version, event_key, event_time, kind, category, raw_score,
        raw_event, score_window_context, window_signals,
        scoring_weights_snapshot, source_aice_id, received_at)
     VALUES ($1, $2::numeric, ${eventTimeExpr}, 'k', 'c', 0.5,
             '{}'::jsonb, '{}'::jsonb, '{}'::jsonb,
             '{}'::jsonb, 'aice-1', ${receivedAtExpr})`,
    [baselineVersion, eventKey],
  );
}

describe.skipIf(!hasPostgres)(
  "computeCombinedRecentEventVolume — window",
  () => {
    let dbName: string;

    beforeAll(async () => {
      const db = await createTestDatabase("group_cost_preview_cust");
      dbName = db.dbName;
      testPool = db.pool;
      await runMigrations(testPool, CUSTOMER_MIGRATIONS_DIR, CUSTOMER_LOCK_ID);
    }, 60_000);

    afterAll(async () => {
      await dropTestDatabase(dbName, testPool);
      await closeAdminPool();
    }, 30_000);

    afterEach(async () => {
      await testPool.query("DELETE FROM baseline_event");
    });

    it("counts canonical baseline rows inside the trailing 30-day window", async () => {
      // Two distinct events, both within the trailing window.
      await seedBaselineEvent(
        testPool,
        "100",
        "NOW() - INTERVAL '1 day'",
        "NOW() - INTERVAL '1 day'",
      );
      await seedBaselineEvent(
        testPool,
        "101",
        "NOW() - INTERVAL '10 days'",
        "NOW() - INTERVAL '10 days'",
      );
      expect(await computeCombinedRecentEventVolume([MEMBER_A])).toBe(2);
    });

    it("excludes events older than the trailing window", async () => {
      await seedBaselineEvent(
        testPool,
        "200",
        "NOW() - INTERVAL '2 days'",
        "NOW() - INTERVAL '2 days'",
      );
      // 40 days old — outside the trailing 30-day window.
      await seedBaselineEvent(
        testPool,
        "201",
        "NOW() - INTERVAL '40 days'",
        "NOW() - INTERVAL '40 days'",
      );
      expect(await computeCombinedRecentEventVolume([MEMBER_A])).toBe(1);
    });

    it("excludes a future-dated canonical baseline row (regression: bounded upper end)", async () => {
      await seedBaselineEvent(
        testPool,
        "300",
        "NOW() - INTERVAL '3 days'",
        "NOW() - INTERVAL '3 days'",
      );
      // event_time in the future — must NOT be counted. Without the `< NOW()`
      // upper bound this row would inflate the preview, diverging from the
      // report-feeding event count the figure mirrors.
      await seedBaselineEvent(
        testPool,
        "301",
        "NOW() + INTERVAL '2 days'",
        "NOW()",
      );
      expect(await computeCombinedRecentEventVolume([MEMBER_A])).toBe(1);
    });
  },
);
