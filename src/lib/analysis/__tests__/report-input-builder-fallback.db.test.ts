// #465 — never-drop leaf coverage + hybrid cross-model scoring DB tests.
//
// Exercises the preference-ordered leaf selection (default report falls back to
// a configured non-report model when the report-model leaf is missing, but an
// alternate-model report stays strict), the hybrid aggregation (calibrated
// scores from the report-model subset only, narrative over the full set), the
// refs carrying their own model, and determinism across regenerations.
//
// The model catalog supplies the fallback order. It is read once per process
// and cached, so the env is set BEFORE importing the builder (which imports
// `model-catalog`). The configured default stays `openai/gpt-4o`; the catalog
// adds `openai/gpt-5.5` as the single fallback.

process.env.ANALYSIS_MODEL_CATALOG = JSON.stringify([
  { modelName: "openai", model: "gpt-4o" },
  { modelName: "openai", model: "gpt-5.5" },
]);

import { join } from "node:path";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  closeAdminPool,
  createTestDatabase,
  dropTestDatabase,
  hasPostgres,
} from "@/lib/db/__tests__/db-test-helpers";
import { runMigrations } from "@/lib/db/migrate";

vi.mock("server-only", () => ({}));

const { buildPeriodicReportInput, buildCanonicalPinnedReportInput } =
  await import("../report-input-builder");

const AUTH_MIGRATIONS_DIR = join(process.cwd(), "migrations", "auth");
const CUSTOMER_MIGRATIONS_DIR = join(process.cwd(), "migrations", "customer");
const AUTH_LOCK_ID = 2411;
const CUSTOMER_LOCK_ID = 2412;
const CUSTOMER_ID = "00000000-0000-0000-0000-0000000000e1";
const TZ = "Asia/Seoul";
const BUCKET = "2026-05-26";
const IN_WINDOW = "2026-05-26T02:00:00Z"; // 11:00 KST, inside the day
const NOW = "2026-05-27T00:00:00Z";

const DEFAULT_VARIANT = {
  tz: TZ,
  lang: "ENGLISH",
  modelName: "openai",
  model: "gpt-4o",
};
const ALT_VARIANT = {
  tz: TZ,
  lang: "ENGLISH",
  modelName: "openai",
  model: "gpt-5.5",
};

async function seedStory(
  customerPool: Pool,
  storyId: string,
  receivedAt: string,
): Promise<void> {
  await customerPool.query(
    `INSERT INTO story
       (story_id, story_version, kind, time_window_start, time_window_end,
        summary_payload, source_aice_id, received_at)
     VALUES ($1::bigint, 'v1', 'auto_correlated',
             $2::timestamptz, ($2::timestamptz + INTERVAL '10 minutes'),
             '{}'::jsonb, 'aice-1', $2::timestamptz)`,
    [storyId, receivedAt],
  );
}

async function seedStoryResult(
  customerPool: Pool,
  storyId: string,
  model: string,
  tier: string,
  severity: number,
  likelihood: number,
): Promise<void> {
  await customerPool.query(
    `INSERT INTO story_analysis_result
       (customer_id, story_id, lang, model_name, model,
        model_actual_version, prompt_version, generation,
        severity_score, likelihood_score,
        severity_factors, likelihood_factors, ttp_tags,
        priority_tier, analysis_text, input_event_refs, input_fact_refs,
        input_hash, redaction_policy_version)
     VALUES ($1, $2::bigint, 'ENGLISH', 'openai', $3,
             'mv', 'pv', 1,
             $4, $5,
             '[]'::jsonb, '[]'::jsonb, '["T1078"]'::jsonb,
             $6, $7, '[]'::jsonb, '[]'::jsonb, 'h', 'policy-A')`,
    [
      CUSTOMER_ID,
      storyId,
      model,
      severity,
      likelihood,
      tier,
      `story ${storyId} ${model}`,
    ],
  );
}

async function seedBaselineEvent(
  customerPool: Pool,
  eventKey: string,
  eventTime: string,
): Promise<void> {
  await customerPool.query(
    `INSERT INTO baseline_event
       (baseline_version, event_key, event_time, kind, category, raw_score,
        raw_event, score_window_context, window_signals,
        scoring_weights_snapshot, source_aice_id, received_at)
     VALUES ('vA', $1::numeric, $2::timestamptz, 'k', 'recon', 0.5,
             '{}'::jsonb, '{}'::jsonb, '{}'::jsonb,
             '{}'::jsonb, 'aice-1', $2::timestamptz)`,
    [eventKey, eventTime],
  );
}

async function seedEventResult(
  customerPool: Pool,
  eventKey: string,
  model: string,
  tier: string,
  severity: number,
  likelihood: number,
): Promise<void> {
  await customerPool.query(
    `INSERT INTO event_analysis_result
       (aice_id, event_key, lang, model_name, model, generation,
        severity_score, likelihood_score,
        severity_factors, likelihood_factors, ttp_tags,
        priority_tier, analysis_text, redaction_policy_version, requested_by)
     VALUES ('aice-1', $1::numeric, 'ENGLISH', 'openai', $2, 1,
             $3, $4,
             '[]'::jsonb, '[]'::jsonb, '["T1110"]'::jsonb,
             $5, $6, 'policy-A', gen_random_uuid())`,
    [eventKey, model, severity, likelihood, tier, `event ${eventKey} ${model}`],
  );
}

async function seedState(authPool: Pool, storyId: string): Promise<void> {
  await authPool.query(
    `INSERT INTO story_analysis_state (customer_id, story_id, status)
     VALUES ($1, $2::bigint, 'ready')
     ON CONFLICT (customer_id, story_id) DO UPDATE SET status = 'ready'`,
    [CUSTOMER_ID, storyId],
  );
}

describe.skipIf(!hasPostgres)("#465 never-drop + hybrid scoring (db)", () => {
  let authDbName: string;
  let authPool: Pool;
  let customerDbName: string;
  let customerPool: Pool;

  beforeAll(async () => {
    const auth = await createTestDatabase("report_fallback_auth");
    authDbName = auth.dbName;
    authPool = auth.pool;
    await runMigrations(authPool, AUTH_MIGRATIONS_DIR, AUTH_LOCK_ID);

    const cust = await createTestDatabase("report_fallback_cust");
    customerDbName = cust.dbName;
    customerPool = cust.pool;
    await runMigrations(
      customerPool,
      CUSTOMER_MIGRATIONS_DIR,
      CUSTOMER_LOCK_ID,
    );

    await authPool.query(
      `INSERT INTO customers (id, external_key, name, database_status, timezone)
       VALUES ($1, 'rfb-1', 'RFB Customer', 'active', $2)`,
      [CUSTOMER_ID, TZ],
    );

    // Story 8001: BOTH a gpt-4o (report model) and a gpt-5.5 leaf. The default
    // report must prefer the gpt-4o leaf (rank 1).
    await seedStory(customerPool, "8001", IN_WINDOW);
    await seedStoryResult(customerPool, "8001", "gpt-4o", "HIGH", 0.8, 0.7);
    await seedStoryResult(customerPool, "8001", "gpt-5.5", "HIGH", 0.9, 0.85);
    await seedState(authPool, "8001");

    // Story 8002: ONLY a gpt-5.5 leaf. The default report must NOT drop it —
    // it falls back to the gpt-5.5 leaf — but its high score must NOT enter the
    // default report's hybrid aggregate.
    await seedStory(customerPool, "8002", IN_WINDOW);
    await seedStoryResult(customerPool, "8002", "gpt-5.5", "HIGH", 0.95, 0.9);
    await seedState(authPool, "8002");

    // Story 8003: ONLY a gpt-4o leaf. Present in the default report; the
    // alternate (gpt-5.5) report must drop it (strict, no fallback).
    await seedStory(customerPool, "8003", IN_WINDOW);
    await seedStoryResult(customerPool, "8003", "gpt-4o", "MEDIUM", 0.5, 0.5);
    await seedState(authPool, "8003");

    // Event 9001: gpt-4o leaf only.
    await seedBaselineEvent(customerPool, "9001", IN_WINDOW);
    await seedEventResult(customerPool, "9001", "gpt-4o", "MEDIUM", 0.6, 0.55);

    // Event 9002: gpt-5.5 leaf only (fallback target; high score).
    await seedBaselineEvent(customerPool, "9002", IN_WINDOW);
    await seedEventResult(
      customerPool,
      "9002",
      "gpt-5.5",
      "CRITICAL",
      0.99,
      0.95,
    );
  });

  afterAll(async () => {
    await dropTestDatabase(authDbName, authPool);
    await dropTestDatabase(customerDbName, customerPool);
    await closeAdminPool();
  });

  it("never drops a fallback-only leaf and prefers the report model when both exist", async () => {
    const res = await buildPeriodicReportInput({
      authPool,
      customerPool,
      customerId: CUSTOMER_ID,
      period: "DAILY",
      bucketDate: BUCKET,
      variant: DEFAULT_VARIANT,
      nowIso: NOW,
    });

    // All three stories surface — including 8002 which only has a gpt-5.5 leaf.
    const storyById = new Map(
      res.storyRefs.map((r) => [r.story_id, r] as const),
    );
    expect([...storyById.keys()].sort()).toEqual(["8001", "8002", "8003"]);
    // 8001 prefers its report-model (gpt-4o) leaf; 8002 falls back to gpt-5.5.
    expect(storyById.get("8001")?.model).toBe("gpt-4o");
    expect(storyById.get("8002")?.model).toBe("gpt-5.5");
    expect(storyById.get("8003")?.model).toBe("gpt-4o");

    // Events: both surface; 9002 falls back to gpt-5.5.
    const eventByKey = new Map(
      res.eventRefs.map((r) => [r.event_key, r] as const),
    );
    expect([...eventByKey.keys()].sort()).toEqual(["9001", "9002"]);
    expect(eventByKey.get("9001")?.model).toBe("gpt-4o");
    expect(eventByKey.get("9002")?.model).toBe("gpt-5.5");
  });

  it("computes aggregate scores from the report-model subset only (fallback leaves narrated, not scored)", async () => {
    const res = await buildPeriodicReportInput({
      authPool,
      customerPool,
      customerId: CUSTOMER_ID,
      period: "DAILY",
      bucketDate: BUCKET,
      variant: DEFAULT_VARIANT,
      nowIso: NOW,
    });

    // The fallback (gpt-5.5) leaves are NARRATED — present in the aimer inputs.
    expect(res.aimerInputs.storyAnalyses.map((s) => s.storyId)).toContain(
      "8002",
    );
    expect(res.aimerInputs.eventAnalyses.map((e) => e.eventRef)).toContain(
      "aice-1:9002",
    );

    // ...but NOT SCORED: the aggregate is the max over the report-model (gpt-4o)
    // leaves + (zero) drift, so it equals the gpt-4o story leaf's 0.8 — never
    // the excluded gpt-5.5 story 0.95 / event 0.99.
    expect(res.aggregateSeverityScore).toBe(0.8);
    expect(res.aggregateLikelihoodScore).toBe(0.7);
    expect(res.aggregateSeverityScore).toBeLessThan(0.95);

    // TTP tags stay on the FULL selected set (coverage facet, not a score).
    expect(res.aggregateTtpTags).toEqual(["T1078", "T1110"]);
  });

  it("keeps an alternate-model report strict (no fallback) and scores it from its own leaves", async () => {
    const res = await buildPeriodicReportInput({
      authPool,
      customerPool,
      customerId: CUSTOMER_ID,
      period: "DAILY",
      bucketDate: BUCKET,
      variant: ALT_VARIANT,
      nowIso: NOW,
    });

    // Strict: only stories/events with a gpt-5.5 leaf. 8003 (gpt-4o only) and
    // 9001 (gpt-4o only) are dropped — NOT filled from gpt-4o.
    expect(res.storyRefs.map((r) => r.story_id).sort()).toEqual([
      "8001",
      "8002",
    ]);
    expect(res.storyRefs.every((r) => r.model === "gpt-5.5")).toBe(true);
    expect(res.eventRefs.map((r) => r.event_key)).toEqual(["9002"]);
    expect(res.eventRefs.every((r) => r.model === "gpt-5.5")).toBe(true);

    // Every selected leaf is the report model, so the aggregate uses them all:
    // max(story 0.95, story 0.9, event 0.99) = 0.99 — in contrast to the
    // default report's hybrid 0.8 over the same underlying data.
    expect(res.aggregateSeverityScore).toBe(0.99);
  });

  it("selects deterministically across regenerations (stable refs + input_hash)", async () => {
    const a = await buildPeriodicReportInput({
      authPool,
      customerPool,
      customerId: CUSTOMER_ID,
      period: "DAILY",
      bucketDate: BUCKET,
      variant: DEFAULT_VARIANT,
      nowIso: NOW,
    });
    const b = await buildPeriodicReportInput({
      authPool,
      customerPool,
      customerId: CUSTOMER_ID,
      period: "DAILY",
      bucketDate: BUCKET,
      variant: DEFAULT_VARIANT,
      nowIso: NOW,
    });
    expect(a.storyRefs).toEqual(b.storyRefs);
    expect(a.eventRefs).toEqual(b.eventRefs);
    expect(a.inputHash).toBe(b.inputHash);
  });

  it("reads legacy (model-less) refs back at the report model", async () => {
    // Simulate a pre-#465 canonical whose refs carry no model. The pinned
    // build must resolve each leaf at the report variant's own model and
    // surface that model on the rebuilt refs.
    const pinned = await buildCanonicalPinnedReportInput({
      customerPool,
      customerId: CUSTOMER_ID,
      period: "DAILY",
      bucketDate: BUCKET,
      variant: DEFAULT_VARIANT,
      nowIso: NOW,
      storyRefs: [{ story_id: "8001", generation: 1 }],
      eventRefs: [{ aice_id: "aice-1", event_key: "9001", generation: 1 }],
    });
    expect(pinned.complete).toBe(true);
    if (!pinned.complete) return;
    expect(pinned.built.storyRefs).toEqual([
      {
        story_id: "8001",
        generation: 1,
        model_name: "openai",
        model: "gpt-4o",
      },
    ]);
    expect(pinned.built.eventRefs).toEqual([
      {
        aice_id: "aice-1",
        event_key: "9001",
        generation: 1,
        model_name: "openai",
        model: "gpt-4o",
      },
    ]);
  });
});
