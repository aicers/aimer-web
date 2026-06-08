// Integration test for the report-variant refresh (#469) across the auth DB
// (report + story state/job rows, refresh run/item tables) and a customer DB
// (event/story leaves the per-variant drain gate reads). Validates:
//   - enqueue-recency enumeration (out-of-window buckets excluded),
//   - per-variant anchored drain gating on BOTH the event and story leaf
//     signals over each variant's own period window,
//   - the MAX_GENERATION cap + queued/processing dedup on the bulk enqueue,
//   - the generation bump on a drained variant, and run-to-run idempotency,
//   - run/item persistence round-trip.

import { join } from "node:path";
import type { Pool, PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  closeAdminPool,
  createTestDatabase,
  dropTestDatabase,
  hasPostgres,
} from "@/lib/db/__tests__/db-test-helpers";
import { runMigrations } from "@/lib/db/migrate";

vi.mock("server-only", () => ({}));

const {
  evaluateCandidates,
  executeReportRefresh,
  planRefresh,
  MAX_GENERATION,
} = await import("../report-refresh");
type RefreshScope = import("../report-refresh").RefreshScope;
const { recordRun, getRun, getRunItems, listRuns } = await import(
  "../report-refresh-store"
);

const AUTH_MIGRATIONS = join(process.cwd(), "migrations", "auth");
const CUSTOMER_MIGRATIONS = join(process.cwd(), "migrations", "customer");
const AUTH_LOCK = 4690;
const CUSTOMER_LOCK = 4691;

const CUSTOMER_ID = "c0000000-0000-0000-0000-000000000469";
const CREATED_BY = "a0000000-0000-0000-0000-000000000469";
const AICE = "aice-469";
const TARGET = { lang: "ENGLISH", modelName: "openai", model: "gpt-5.5" };
const NOW_ISO = "2026-06-08T00:00:00.000Z";

const scope: RefreshScope = {
  customerId: CUSTOMER_ID,
  windowDays: 7,
  periods: ["DAILY"],
  tz: null,
  maxVariants: null,
};

describe.skipIf(!hasPostgres)("report-variant refresh (db)", () => {
  let authPool: Pool;
  let custPool: Pool;
  let authDb: string;
  let custDb: string;

  async function addState(bucketDate: string, status: string) {
    await authPool.query(
      `INSERT INTO periodic_report_state
         (customer_id, period, bucket_date, tz, status)
       VALUES ($1, 'DAILY', $2::date, 'UTC', $3)`,
      [CUSTOMER_ID, bucketDate, status],
    );
  }

  async function addJob(
    bucketDate: string,
    status: string,
    generation: number,
  ) {
    await authPool.query(
      `INSERT INTO periodic_report_job
         (customer_id, period, bucket_date, tz, lang, model_name, model,
          status, generation)
       VALUES ($1, 'DAILY', $2::date, 'UTC', $3, $4, $5, $6, $7)`,
      [
        CUSTOMER_ID,
        bucketDate,
        TARGET.lang,
        TARGET.modelName,
        TARGET.model,
        status,
        generation,
      ],
    );
  }

  async function seedEventLeaf(eventKey: string, eventTime: string) {
    await custPool.query(
      `INSERT INTO baseline_event
         (baseline_version, event_key, event_time, kind, category, raw_score,
          raw_event, score_window_context, window_signals,
          scoring_weights_snapshot, source_aice_id, received_at)
       VALUES ('vA', $1::numeric, $2::timestamptz, 'k', 'recon', 0.5,
               '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb,
               $3, $2::timestamptz)`,
      [eventKey, eventTime, AICE],
    );
    // An OLD-model ENGLISH leaf (not the target) → outstanding.
    await custPool.query(
      `INSERT INTO event_analysis_result
         (aice_id, event_key, lang, model_name, model,
          model_actual_version, prompt_version, generation,
          severity_score, likelihood_score,
          severity_factors, likelihood_factors, ttp_tags,
          priority_tier, analysis_text, redaction_policy_version,
          requested_by, superseded_at)
       VALUES ($1, $2::numeric, 'ENGLISH', 'openai', 'gpt-4o',
               'mv', 'pv', 1, 0.5, 0.5,
               '[]'::jsonb, '[]'::jsonb, '[]'::jsonb,
               'MEDIUM', 'text', 'policy-A', gen_random_uuid(), NULL)`,
      [AICE, eventKey],
    );
    await custPool.query(
      `INSERT INTO detection_events
         (aice_id, event_key, redacted_event, redaction_policy_version,
          schema_version, payload_hash, source, ingested_by)
       VALUES ($1, $2::numeric, '{}'::jsonb, 'policy-A', 'v1', 'h',
               'bridge', gen_random_uuid())`,
      [AICE, eventKey],
    );
  }

  async function seedStoryLeaf(
    storyId: number,
    windowStart: string,
    windowEnd: string,
  ) {
    await custPool.query(
      `INSERT INTO story
         (story_id, story_version, kind, time_window_start, time_window_end,
          summary_payload, source_aice_id)
       VALUES ($1::bigint, 'v1', 'auto_correlated', $2::timestamptz,
               $3::timestamptz, '{}'::jsonb, $4)`,
      [storyId, windowStart, windowEnd, AICE],
    );
    await authPool.query(
      `INSERT INTO story_analysis_state (customer_id, story_id, status)
       VALUES ($1, $2::bigint, 'ready')`,
      [CUSTOMER_ID, storyId],
    );
    // An existing ENGLISH analysis on the OLD model only → the target
    // variant is absent, so the story side is outstanding.
    await authPool.query(
      `INSERT INTO story_analysis_job
         (customer_id, story_id, lang, model_name, model, status, generation)
       VALUES ($1, $2::bigint, 'ENGLISH', 'openai', 'gpt-4o', 'done', 1)`,
      [CUSTOMER_ID, storyId],
    );
  }

  beforeAll(async () => {
    const auth = await createTestDatabase("report_refresh_auth");
    authPool = auth.pool;
    authDb = auth.dbName;
    await runMigrations(authPool, AUTH_MIGRATIONS, AUTH_LOCK);
    await authPool.query(
      `INSERT INTO customers (id, external_key, name, database_status, timezone)
       VALUES ($1, 'refresh-469', 'Refresh 469', 'active', 'UTC')`,
      [CUSTOMER_ID],
    );

    const cust = await createTestDatabase("report_refresh_cust");
    custPool = cust.pool;
    custDb = cust.dbName;
    await runMigrations(custPool, CUSTOMER_MIGRATIONS, CUSTOMER_LOCK);

    // 06-05: drained (no leaves in its window) + existing done job → refresh.
    await addState("2026-06-05", "ready");
    await addJob("2026-06-05", "done", 1);
    // 06-04: an outstanding OLD-model event leaf in its window → gated.
    await addState("2026-06-04", "ready");
    await seedEventLeaf("1004", "2026-06-04T12:00:00Z");
    // 06-03: a regeneration already queued → already_queued (dedup).
    await addState("2026-06-03", "ready");
    await addJob("2026-06-03", "queued", 1);
    // 06-02: an existing job at the generation cap → capped.
    await addState("2026-06-02", "ready");
    await addJob("2026-06-02", "done", MAX_GENERATION);
    // 06-01: archived parent state → source_unavailable.
    await addState("2026-06-01", "archived");
    // 06-06: an outstanding story leaf overlapping its window → gated (story).
    await addState("2026-06-06", "ready");
    await seedStoryLeaf(906, "2026-06-06T06:00:00Z", "2026-06-06T18:00:00Z");
    // 05-20: outside the 7-day enqueue window → excluded from enumeration.
    await addState("2026-05-20", "ready");
  }, 60_000);

  afterAll(async () => {
    await dropTestDatabase(authDb, authPool);
    await dropTestDatabase(custDb, custPool);
    await closeAdminPool();
  }, 30_000);

  it("evaluates each in-window variant into its anchored gate outcome", async () => {
    const evals = await evaluateCandidates(
      authPool,
      custPool,
      scope,
      TARGET,
      NOW_ISO,
    );
    const byBucket = new Map(evals.map((e) => [e.bucketDate, e.preOutcome]));
    // 05-20 is outside the enqueue window → not enumerated.
    expect(byBucket.has("2026-05-20")).toBe(false);
    expect(evals).toHaveLength(6);
    expect(byBucket.get("2026-06-05")).toBe("refreshable");
    expect(byBucket.get("2026-06-04")).toBe("gated"); // event leaf outstanding
    expect(byBucket.get("2026-06-06")).toBe("gated"); // story leaf outstanding
    expect(byBucket.get("2026-06-03")).toBe("already_queued");
    expect(byBucket.get("2026-06-02")).toBe("capped");
    expect(byBucket.get("2026-06-01")).toBe("source_unavailable");
  });

  it("plans counts with one refreshable variant and no silent caps", async () => {
    const evals = await evaluateCandidates(
      authPool,
      custPool,
      scope,
      TARGET,
      NOW_ISO,
    );
    const { counts } = planRefresh(evals, null);
    expect(counts).toEqual({
      totalVariants: 6,
      refreshed: 1,
      gated: 2,
      alreadyQueued: 1,
      capped: 1,
      sourceUnavailable: 1,
      limited: 0,
    });
    // A per-run cap of 0 turns the lone refreshable into `limited`.
    const capped = planRefresh(evals, 0);
    expect(capped.counts.refreshed).toBe(0);
    expect(capped.counts.limited).toBe(1);
  });

  it("bumps the drained variant's generation and is idempotent on re-run", async () => {
    const client: PoolClient = await authPool.connect();
    try {
      await client.query("BEGIN");
      const exec = await executeReportRefresh(
        client,
        custPool,
        { ...scope },
        TARGET,
        CREATED_BY,
        new Date(NOW_ISO),
      );
      await client.query("COMMIT");
      expect(exec.counts.refreshed).toBe(1);
      const refreshed = exec.variants.find((v) => v.outcome === "refreshed");
      expect(refreshed?.bucketDate).toBe("2026-06-05");
      expect(refreshed?.generation).toBe(2);
    } finally {
      client.release();
    }

    const job = await authPool.query<{ status: string; generation: number }>(
      `SELECT status, generation FROM periodic_report_job
        WHERE customer_id = $1 AND period = 'DAILY'
          AND bucket_date = '2026-06-05'::date AND tz = 'UTC'
          AND lang = $2 AND model_name = $3 AND model = $4`,
      [CUSTOMER_ID, TARGET.lang, TARGET.modelName, TARGET.model],
    );
    expect(job.rows[0]).toMatchObject({ status: "queued", generation: 2 });

    // Re-running must not double-bump: 06-05 is now queued → already_queued.
    const client2: PoolClient = await authPool.connect();
    try {
      await client2.query("BEGIN");
      const exec2 = await executeReportRefresh(
        client2,
        custPool,
        { ...scope },
        TARGET,
        CREATED_BY,
        new Date(NOW_ISO),
      );
      await client2.query("COMMIT");
      expect(exec2.counts.refreshed).toBe(0);
      expect(exec2.counts.alreadyQueued).toBe(2); // 06-03 and now 06-05
    } finally {
      client2.release();
    }
    const job2 = await authPool.query<{ generation: number }>(
      `SELECT generation FROM periodic_report_job
        WHERE customer_id = $1 AND bucket_date = '2026-06-05'::date
          AND period = 'DAILY' AND tz = 'UTC'
          AND lang = $2 AND model_name = $3 AND model = $4`,
      [CUSTOMER_ID, TARGET.lang, TARGET.modelName, TARGET.model],
    );
    expect(job2.rows[0].generation).toBe(2); // unchanged
  });

  it("persists the run and its per-variant outcome rows", async () => {
    const client: PoolClient = await authPool.connect();
    let runId: string;
    try {
      await client.query("BEGIN");
      const evals = await evaluateCandidates(
        client,
        custPool,
        { ...scope },
        TARGET,
        NOW_ISO,
      );
      const plan = planRefresh(evals, null);
      const now = new Date(NOW_ISO);
      const run = await recordRun(client, {
        scope: { ...scope },
        target: TARGET,
        windowStart: new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000),
        windowEnd: now,
        counts: plan.counts,
        variants: plan.variants,
        createdBy: CREATED_BY,
        now,
      });
      runId = run.id;
      await client.query("COMMIT");
      expect(run.status).toBe("completed");
      expect(run.totalVariants).toBe(6);
    } finally {
      client.release();
    }

    const fetched = await getRun(authPool, CUSTOMER_ID, runId);
    expect(fetched?.gated).toBe(2);
    expect(fetched?.sourceUnavailable).toBe(1);

    const items = await getRunItems(authPool, runId);
    expect(items).toHaveLength(6);
    const gated = items
      .filter((i) => i.category === "gated")
      .map((i) => i.bucketDate);
    expect(gated.sort()).toEqual(["2026-06-04", "2026-06-06"]);

    const runs = await listRuns(authPool, CUSTOMER_ID);
    expect(runs.length).toBeGreaterThanOrEqual(1);
  });
});
