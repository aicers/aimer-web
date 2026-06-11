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
         (subject_id, period, bucket_date, tz, status)
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
         (subject_id, period, bucket_date, tz, lang, model_name, model,
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
          priority_tier, analysis_text, event_time, redaction_policy_version,
          requested_by, superseded_at)
       VALUES ($1, $2::numeric, 'ENGLISH', 'openai', 'gpt-4o',
               'mv', 'pv', 1, 0.5, 0.5,
               '[]'::jsonb, '[]'::jsonb, '[]'::jsonb,
               'MEDIUM', 'text', '2026-05-20T00:00:00Z'::timestamptz, 'policy-A', gen_random_uuid(), NULL)`,
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
        WHERE subject_id = $1 AND period = 'DAILY'
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
        WHERE subject_id = $1 AND bucket_date = '2026-06-05'::date
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

// The per-variant anchored gate window (Scope §3) is the highest-risk part of
// the refresh: `resolveAnchoredWindow` re-derives the report builder's
// per-period window math, so a regression there would silently gate the wrong
// leaf set. The block above only exercises DAILY; this block covers the
// non-daily periods the acceptance criteria call out — LIVE (anchored to
// `now`), WEEKLY/MONTHLY buckets whose aggregation window extends well beyond
// the 7-day enqueue window, the timezone/DST boundary, and that a leaf which
// gates a WEEKLY bucket does NOT gate a DAILY bucket whose narrower window
// excludes it (per-period windows, not a flat window).
//
// Anchored at NOW = 2026-03-15, so the 7-day enqueue window is
// [2026-03-08, 2026-03-15]. Leaves are placed at 03-20 (after the enqueue
// window) precisely so a flat-7-day gate would miss them but the longer
// weekly/monthly aggregation windows must not.
const CID2 = "c0000000-0000-0000-0000-000000000470";
const CREATED_BY2 = "a0000000-0000-0000-0000-000000000470";
const AICE2 = "aice-470";
const NOW2_ISO = "2026-03-15T00:00:00.000Z";

const scope2: RefreshScope = {
  customerId: CID2,
  windowDays: 7,
  periods: ["LIVE", "DAILY", "WEEKLY", "MONTHLY"],
  tz: null,
  maxVariants: null,
};

describe.skipIf(!hasPostgres)(
  "report-variant refresh — anchored gate window (db)",
  () => {
    let authPool: Pool;
    let custPool: Pool;
    let authDb: string;
    let custDb: string;

    async function addState(
      period: string,
      bucketDate: string,
      tz: string,
      status = "ready",
    ) {
      await authPool.query(
        `INSERT INTO periodic_report_state
           (subject_id, period, bucket_date, tz, status)
         VALUES ($1, $2, $3::date, $4, $5)`,
        [CID2, period, bucketDate, tz, status],
      );
    }

    async function addJob(
      period: string,
      bucketDate: string,
      tz: string,
      status: string,
      generation: number,
    ) {
      await authPool.query(
        `INSERT INTO periodic_report_job
           (subject_id, period, bucket_date, tz, lang, model_name, model,
            status, generation)
         VALUES ($1, $2, $3::date, $4, $5, $6, $7, $8, $9)`,
        [
          CID2,
          period,
          bucketDate,
          tz,
          TARGET.lang,
          TARGET.modelName,
          TARGET.model,
          status,
          generation,
        ],
      );
    }

    // An OLD-model event leaf at `eventTime` → outstanding for the target
    // variant, so any window covering `eventTime` is event-gated.
    async function seedEventLeaf(eventKey: string, eventTime: string) {
      await custPool.query(
        `INSERT INTO baseline_event
           (baseline_version, event_key, event_time, kind, category, raw_score,
            raw_event, score_window_context, window_signals,
            scoring_weights_snapshot, source_aice_id, received_at)
         VALUES ('vA', $1::numeric, $2::timestamptz, 'k', 'recon', 0.5,
                 '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb,
                 $3, $2::timestamptz)`,
        [eventKey, eventTime, AICE2],
      );
      await custPool.query(
        `INSERT INTO event_analysis_result
           (aice_id, event_key, lang, model_name, model,
            model_actual_version, prompt_version, generation,
            severity_score, likelihood_score,
            severity_factors, likelihood_factors, ttp_tags,
            priority_tier, analysis_text, event_time, redaction_policy_version,
            requested_by, superseded_at)
         VALUES ($1, $2::numeric, 'ENGLISH', 'openai', 'gpt-4o',
                 'mv', 'pv', 1, 0.5, 0.5,
                 '[]'::jsonb, '[]'::jsonb, '[]'::jsonb,
                 'MEDIUM', 'text', '2026-05-20T00:00:00Z'::timestamptz, 'policy-A', gen_random_uuid(), NULL)`,
        [AICE2, eventKey],
      );
      await custPool.query(
        `INSERT INTO detection_events
           (aice_id, event_key, redacted_event, redaction_policy_version,
            schema_version, payload_hash, source, ingested_by)
         VALUES ($1, $2::numeric, '{}'::jsonb, 'policy-A', 'v1', 'h',
                 'bridge', gen_random_uuid())`,
        [AICE2, eventKey],
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
        [storyId, windowStart, windowEnd, AICE2],
      );
      await authPool.query(
        `INSERT INTO story_analysis_state (customer_id, story_id, status)
         VALUES ($1, $2::bigint, 'ready')`,
        [CID2, storyId],
      );
      await authPool.query(
        `INSERT INTO story_analysis_job
           (customer_id, story_id, lang, model_name, model, status, generation)
         VALUES ($1, $2::bigint, 'ENGLISH', 'openai', 'gpt-4o', 'done', 1)`,
        [CID2, storyId],
      );
    }

    beforeAll(async () => {
      const auth = await createTestDatabase("report_refresh_win_auth");
      authPool = auth.pool;
      authDb = auth.dbName;
      await runMigrations(authPool, AUTH_MIGRATIONS, AUTH_LOCK);
      await authPool.query(
        `INSERT INTO customers (id, external_key, name, database_status, timezone)
         VALUES ($1, 'refresh-470', 'Refresh 470', 'active', 'UTC')`,
        [CID2],
      );

      const cust = await createTestDatabase("report_refresh_win_cust");
      custPool = cust.pool;
      custDb = cust.dbName;
      await runMigrations(custPool, CUSTOMER_MIGRATIONS, CUSTOMER_LOCK);

      // Two OLD-model event leaves and one OLD-model story leaf.
      //  - 03-14 sits inside the enqueue window; 03-20 sits AFTER it.
      //  - The 03-25 story sits far outside every weekly/daily window but
      //    inside the monthly window.
      await seedEventLeaf("7014", "2026-03-14T12:00:00Z");
      await seedEventLeaf("7020", "2026-03-20T12:00:00Z");
      await seedStoryLeaf(7025, "2026-03-25T06:00:00Z", "2026-03-25T18:00:00Z");

      // LIVE @ now: window [now-24h, now] = [03-14, 03-15] → covers 03-14 → gated.
      await addState("LIVE", "2026-03-15", "UTC");
      // WEEKLY @ 03-14: window [03-14, 03-21] → covers 03-20 (outside the
      // 7-day enqueue window) → gated. A flat-7-day gate would miss 03-20.
      await addState("WEEKLY", "2026-03-14", "UTC");
      // WEEKLY @ 03-26: window [03-26, 04-02] → covers NO leaf → refreshable.
      await addState("WEEKLY", "2026-03-26", "UTC");
      await addJob("WEEKLY", "2026-03-26", "UTC", "done", 1);
      // DAILY @ 03-16: window [03-16, 03-17] → covers NO leaf → refreshable.
      // The 03-20 leaf that gates the weekly is OUTSIDE this daily window.
      await addState("DAILY", "2026-03-16", "UTC");
      // DAILY @ 03-08 in America/New_York: window crosses the 2026-03-08
      // spring-forward, so its UTC bounds are [03-08T05:00Z, 03-09T04:00Z]
      // (EST→EDT) — the timezone/DST boundary. No leaf inside → refreshable.
      await addState("DAILY", "2026-03-08", "America/New_York");
      // MONTHLY @ 03-10: window [03-10, 04-10] → covers 03-20 and the 03-25
      // story → gated. Proves the month-long window, far beyond enqueue.
      await addState("MONTHLY", "2026-03-10", "UTC");
    }, 60_000);

    afterAll(async () => {
      await dropTestDatabase(authDb, authPool);
      await dropTestDatabase(custDb, custPool);
      await closeAdminPool();
    }, 30_000);

    it("resolves each period's anchored window and gates per-period", async () => {
      const evals = await evaluateCandidates(
        authPool,
        custPool,
        scope2,
        TARGET,
        NOW2_ISO,
      );
      const by = new Map(
        evals.map((e) => [`${e.period}:${e.bucketDate}:${e.tz}`, e]),
      );

      const live = by.get("LIVE:2026-03-15:UTC");
      expect(live?.preOutcome).toBe("gated");
      expect(live?.windowStart).toBe("2026-03-14T00:00:00.000Z");
      expect(live?.windowEnd).toBe("2026-03-15T00:00:00.000Z");

      // WEEKLY gated by the 03-20 leaf — outside the 7-day enqueue window,
      // inside the report's 7-day aggregation window ending 03-21.
      const weekGated = by.get("WEEKLY:2026-03-14:UTC");
      expect(weekGated?.preOutcome).toBe("gated");
      expect(weekGated?.windowStart).toBe("2026-03-14T00:00:00.000Z");
      expect(weekGated?.windowEnd).toBe("2026-03-21T00:00:00.000Z");

      // DAILY 03-16: its narrow [03-16, 03-17] window EXCLUDES the 03-20 leaf
      // that gates the weekly, so it is refreshable — per-period windows.
      const dayClean = by.get("DAILY:2026-03-16:UTC");
      expect(dayClean?.preOutcome).toBe("refreshable");
      expect(dayClean?.windowStart).toBe("2026-03-16T00:00:00.000Z");
      expect(dayClean?.windowEnd).toBe("2026-03-17T00:00:00.000Z");

      // DST boundary: America/New_York 03-08 spring-forward → 23-hour day.
      const dst = by.get("DAILY:2026-03-08:America/New_York");
      expect(dst?.preOutcome).toBe("refreshable");
      expect(dst?.windowStart).toBe("2026-03-08T05:00:00.000Z");
      expect(dst?.windowEnd).toBe("2026-03-09T04:00:00.000Z");

      // MONTHLY: one calendar month [03-10, 04-10], far beyond the enqueue
      // window → gated by the 03-20 leaf inside it.
      const month = by.get("MONTHLY:2026-03-10:UTC");
      expect(month?.preOutcome).toBe("gated");
      expect(month?.windowStart).toBe("2026-03-10T00:00:00.000Z");
      expect(month?.windowEnd).toBe("2026-04-10T00:00:00.000Z");

      // WEEKLY 03-26: clean window → refreshable (the non-daily bump case).
      const weekClean = by.get("WEEKLY:2026-03-26:UTC");
      expect(weekClean?.preOutcome).toBe("refreshable");
      expect(weekClean?.windowEnd).toBe("2026-04-02T00:00:00.000Z");
    });

    it("refreshes only the drained variants, leaving gated weekly/monthly untouched", async () => {
      const client: PoolClient = await authPool.connect();
      try {
        await client.query("BEGIN");
        const exec = await executeReportRefresh(
          client,
          custPool,
          { ...scope2 },
          TARGET,
          CREATED_BY2,
          new Date(NOW2_ISO),
        );
        await client.query("COMMIT");
        // DAILY 03-16, DAILY-NY 03-08, WEEKLY 03-26 refresh; LIVE, WEEKLY
        // 03-14, MONTHLY 03-10 are gated.
        expect(exec.counts.refreshed).toBe(3);
        expect(exec.counts.gated).toBe(3);
      } finally {
        client.release();
      }

      // The refreshable WEEKLY bumps its existing done job 1 → 2.
      const weekJob = await authPool.query<{
        status: string;
        generation: number;
      }>(
        `SELECT status, generation FROM periodic_report_job
          WHERE subject_id = $1 AND period = 'WEEKLY'
            AND bucket_date = '2026-03-26'::date AND tz = 'UTC'
            AND lang = $2 AND model_name = $3 AND model = $4`,
        [CID2, TARGET.lang, TARGET.modelName, TARGET.model],
      );
      expect(weekJob.rows[0]).toMatchObject({
        status: "queued",
        generation: 2,
      });

      // The gated WEEKLY was never seeded — gating prevents any job write.
      const gatedJob = await authPool.query(
        `SELECT 1 FROM periodic_report_job
          WHERE subject_id = $1 AND period = 'WEEKLY'
            AND bucket_date = '2026-03-14'::date AND tz = 'UTC'
            AND lang = $2 AND model_name = $3 AND model = $4`,
        [CID2, TARGET.lang, TARGET.modelName, TARGET.model],
      );
      expect(gatedJob.rows).toHaveLength(0);
    });
  },
);
