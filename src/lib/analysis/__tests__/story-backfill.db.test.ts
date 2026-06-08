// Story-leaf re-analysis backfill — SQL coverage (#466).
//
// The classification / cap / drain logic is unit-tested with fakes in
// `story-backfill.unit.test.ts`. THIS test exercises the real SQL in
// `createBackfillDeps` against Postgres: the candidate scan (the
// WORKER_LANG existence filter, the target-variant LEFT JOIN, the
// recent-window filter, and the recency ordering) and the idempotent seed /
// requeue
// writes. `liveStoryIds` reads the per-customer runtime pool global and is
// covered by the unit-level source-availability cases instead.

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
  closeAdminPool,
  createTestDatabase,
  dropTestDatabase,
  hasPostgres,
} from "../../db/__tests__/db-test-helpers";
import { runMigrations } from "../../db/migrate";
import { type BackfillScope, createBackfillDeps } from "../story-backfill";

const MIGRATIONS_DIR = join(process.cwd(), "migrations", "auth");
const LOCK_ID = 1466;

const CUSTOMER_ID = "c0000000-0000-0000-0000-000000000466";
const TARGET = { modelName: "openai", model: "gpt-5.5" };
// A fixed "now" so the recent-window filter is deterministic.
const NOW_MS = Date.UTC(2026, 5, 1, 0, 0, 0);
const daysAgoIso = (d: number): string =>
  new Date(NOW_MS - d * 24 * 60 * 60 * 1000).toISOString();

function scope(over: Partial<BackfillScope> = {}): BackfillScope {
  return {
    customerId: CUSTOMER_ID,
    modelName: TARGET.modelName,
    model: TARGET.model,
    windowDays: 7,
    cap: null,
    ...over,
  };
}

describe.skipIf(!hasPostgres)("story-backfill SQL deps (DB)", () => {
  let pool: Pool;
  let dbName: string;

  beforeAll(async () => {
    const created = await createTestDatabase("analysis_story_backfill");
    pool = created.pool;
    dbName = created.dbName;
    await runMigrations(pool, MIGRATIONS_DIR, LOCK_ID);
    await pool.query(
      `INSERT INTO customers (id, external_key, name, database_status, timezone)
       VALUES ($1, 'backfill-466', 'Backfill 466', 'active', 'UTC')`,
      [CUSTOMER_ID],
    );
  }, 60_000);

  afterAll(async () => {
    await dropTestDatabase(dbName, pool);
    await closeAdminPool();
  }, 30_000);

  beforeEach(async () => {
    await pool.query(`DELETE FROM story_analysis_job WHERE customer_id = $1`, [
      CUSTOMER_ID,
    ]);
    await pool.query(
      `DELETE FROM story_analysis_state WHERE customer_id = $1`,
      [CUSTOMER_ID],
    );
  });

  async function addState(
    storyId: number,
    status: string,
    lastMemberDaysAgo: number | null,
  ): Promise<void> {
    await pool.query(
      `INSERT INTO story_analysis_state
         (customer_id, story_id, status, last_member_at)
       VALUES ($1, $2::bigint, $3, $4::timestamptz)`,
      [
        CUSTOMER_ID,
        storyId,
        status,
        lastMemberDaysAgo === null ? null : daysAgoIso(lastMemberDaysAgo),
      ],
    );
  }

  async function addJob(
    storyId: number,
    lang: string,
    modelName: string,
    model: string,
    status: string,
    opts: { dryRun?: boolean; generation?: number } = {},
  ): Promise<void> {
    await pool.query(
      `INSERT INTO story_analysis_job
         (customer_id, story_id, lang, model_name, model,
          status, generation, dry_run)
       VALUES ($1, $2::bigint, $3, $4, $5, $6, $7, $8)`,
      [
        CUSTOMER_ID,
        storyId,
        lang,
        modelName,
        model,
        status,
        opts.generation ?? 1,
        opts.dryRun ?? false,
      ],
    );
  }

  it("scans existing-analysis leaves with target-variant status, window-filtered and recency-ordered", async () => {
    // 1001: ready, recent, only an OLD-model leaf → target absent.
    await addState(1001, "ready", 1);
    await addJob(1001, "ENGLISH", "openai", "gpt-4o", "done");
    // 1002: ready, recent, already has the TARGET leaf done.
    await addState(1002, "ready", 2);
    await addJob(1002, "ENGLISH", TARGET.modelName, TARGET.model, "done");
    // 1003: dirty, recent, old-model leaf in two langs → ONLY the
    // worker-refreshed ENGLISH leaf is a candidate; the KOREAN leaf is out of
    // scope (the worker never refreshes it, so the dirty/drain contract can't
    // cover it).
    await addState(1003, "dirty", 3);
    await addJob(1003, "ENGLISH", "openai", "gpt-4o", "done");
    await addJob(1003, "KOREAN", "openai", "gpt-4o", "done");
    // 1004: archived, recent.
    await addState(1004, "archived", 1);
    await addJob(1004, "ENGLISH", "openai", "gpt-4o", "done");
    // 1005: ready but OUTSIDE the 7-day window.
    await addState(1005, "ready", 30);
    await addJob(1005, "ENGLISH", "openai", "gpt-4o", "done");
    // 1006: pending → never a candidate.
    await addState(1006, "pending", 1);
    await addJob(1006, "ENGLISH", "openai", "gpt-4o", "queued");
    // 1007: ready, recent, but NO job rows → not an existing analysis.
    await addState(1007, "ready", 1);
    // 1008: ready, recent, but ONLY a non-default-language (KOREAN) leaf →
    // not a candidate, since the backfill scans only WORKER_LANG (ENGLISH).
    await addState(1008, "ready", 1);
    await addJob(1008, "KOREAN", "openai", "gpt-4o", "done");

    const deps = createBackfillDeps(pool, NOW_MS);
    const within = await deps.scanCandidates(scope({ windowDays: 7 }));
    const keys = within.map((c) => `${c.storyId}:${c.lang}`);

    // 1005 (window), 1006 (pending), 1007 (no jobs), 1008 (KOREAN-only)
    // excluded; only the ENGLISH leaf of each surviving story remains.
    expect(keys.sort()).toEqual(
      ["1001:ENGLISH", "1002:ENGLISH", "1003:ENGLISH", "1004:ENGLISH"].sort(),
    );

    const byKey = new Map(within.map((c) => [`${c.storyId}:${c.lang}`, c]));
    expect(byKey.get("1001:ENGLISH")?.targetStatus).toBeNull();
    expect(byKey.get("1002:ENGLISH")?.targetStatus).toBe("done");
    expect(byKey.get("1003:ENGLISH")?.stateStatus).toBe("dirty");
    expect(byKey.get("1004:ENGLISH")?.stateStatus).toBe("archived");

    // Recency ordering: most-recent last_member_at first (1001/1004 at 1d).
    const order = within.map((c) => c.storyId);
    expect(order.indexOf("1002")).toBeGreaterThan(order.indexOf("1001"));
    expect(order.indexOf("1003")).toBeGreaterThan(order.indexOf("1002"));

    // No window bound includes the old story 1005.
    const all = await deps.scanCandidates(scope({ windowDays: null }));
    expect(all.some((c) => c.storyId === "1005")).toBe(true);
  });

  it("seedJob inserts a generation-1 queued target leaf and is idempotent", async () => {
    await addState(2001, "ready", 1);
    await addJob(2001, "ENGLISH", "openai", "gpt-4o", "done");

    const deps = createBackfillDeps(pool, NOW_MS);
    await deps.seedJob(
      CUSTOMER_ID,
      "2001",
      "ENGLISH",
      TARGET.modelName,
      TARGET.model,
    );
    const first = await pool.query(
      `SELECT status, generation, dry_run FROM story_analysis_job
        WHERE customer_id = $1 AND story_id = 2001::bigint
          AND model_name = $2 AND model = $3`,
      [CUSTOMER_ID, TARGET.modelName, TARGET.model],
    );
    expect(first.rows[0]).toMatchObject({
      status: "queued",
      generation: 1,
      dry_run: false,
    });

    // Mark it done, then re-seed: DO NOTHING leaves the row untouched (no
    // generation bump, no reset) — coalescing, not force.
    await pool.query(
      `UPDATE story_analysis_job SET status = 'done'
        WHERE customer_id = $1 AND story_id = 2001::bigint
          AND model_name = $2 AND model = $3`,
      [CUSTOMER_ID, TARGET.modelName, TARGET.model],
    );
    await deps.seedJob(
      CUSTOMER_ID,
      "2001",
      "ENGLISH",
      TARGET.modelName,
      TARGET.model,
    );
    const second = await pool.query(
      `SELECT status, generation FROM story_analysis_job
        WHERE customer_id = $1 AND story_id = 2001::bigint
          AND model_name = $2 AND model = $3`,
      [CUSTOMER_ID, TARGET.modelName, TARGET.model],
    );
    expect(second.rows[0]).toMatchObject({ status: "done", generation: 1 });
  });

  it("requeueJob resets a failed/dry-run leaf at the same generation, leaving done untouched", async () => {
    await addState(3001, "ready", 1);
    // A failed target leaf at generation 2.
    await addJob(3001, "ENGLISH", TARGET.modelName, TARGET.model, "failed", {
      generation: 2,
    });
    // A done target leaf for another lang — must NOT be requeued.
    await addJob(3001, "KOREAN", TARGET.modelName, TARGET.model, "done", {
      generation: 2,
    });

    const deps = createBackfillDeps(pool, NOW_MS);
    await deps.requeueJob(
      CUSTOMER_ID,
      "3001",
      "ENGLISH",
      TARGET.modelName,
      TARGET.model,
    );
    await deps.requeueJob(
      CUSTOMER_ID,
      "3001",
      "KOREAN",
      TARGET.modelName,
      TARGET.model,
    );

    const en = await pool.query(
      `SELECT status, generation FROM story_analysis_job
        WHERE customer_id = $1 AND story_id = 3001::bigint AND lang = 'ENGLISH'`,
      [CUSTOMER_ID],
    );
    // Requeued at the SAME generation (no bump).
    expect(en.rows[0]).toMatchObject({ status: "queued", generation: 2 });

    const ko = await pool.query(
      `SELECT status FROM story_analysis_job
        WHERE customer_id = $1 AND story_id = 3001::bigint AND lang = 'KOREAN'`,
      [CUSTOMER_ID],
    );
    expect(ko.rows[0].status).toBe("done");
  });
});
