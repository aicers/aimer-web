// RFC 0002 Phase 2 (#297) — periodic report worker DB tests.
//
// Covers issue gates:
//   - happy-path commit ordering (customer-DB result + auth-DB finalize)
//   - zero-leaf baseline-only redaction_policy_version sentinel
//   - post-LLM crash recovery via the pickup-time result-row probe
//     (no second LLM call)
//   - LIVE next_due_at re-queue skips archived parent state (round-14 5)
//   - dirty LIVE row past next_due_at bumped once per tick, not twice (r9 1)
//   - runtime pickup skips a queued job archived after queueing (r2 2)

import { join } from "node:path";
import { ClientError } from "graphql-request";
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
// The worker emits fire-and-forget audit rows; this DB test focuses on
// the auth/customer commit ordering, so stub the audit sink (mirrors the
// story-worker unit tests) to avoid real audit-DB I/O.
vi.mock("@/lib/audit", () => ({ auditLog: vi.fn(async () => {}) }));

// Pin the eager language set to English-only for the lifecycle cases below,
// which assert the single English-variant job's transitions. With the app
// default `DEFAULT_LOCALE=ko` the eager set would also seed a Korean job
// (#389 Part A); the dedicated multi-language seeding behavior is covered in
// `report-worker-eager.db.test.ts`. Set before the dynamic import so the
// module reads it at init.
process.env.DEFAULT_LOCALE = "en";

const {
  processReportJob,
  requeueLiveReportJobs,
  seedRealReportJobs,
  tickReportJobsOnce,
  MAX_GENERATION,
} = await import("../report-worker");

const AUTH_MIGRATIONS_DIR = join(process.cwd(), "migrations", "auth");
const CUSTOMER_MIGRATIONS_DIR = join(process.cwd(), "migrations", "customer");
const AUTH_LOCK_ID = 2501;
const CUSTOMER_LOCK_ID = 2502;
const CUSTOMER_ID = "00000000-0000-0000-0000-0000000000e1";
// A second customer sharing the customer DB. `story_analysis_result` is keyed
// by `customer_id`, so this exercises the pinned story lookup's customer scope
// (#412 round-3): a same-`story_id` story leaf owned by another customer must
// NOT satisfy the completeness gate for CUSTOMER_ID.
const OTHER_CUSTOMER_ID = "00000000-0000-0000-0000-0000000000e2";
const TZ = "Asia/Seoul";
const LIVE_BUCKET = "1970-01-01";

// aimer returns a single JSON-encoded `sections` string (#360), matching its
// PERIODIC_SECURITY_REPORT output schema (prompt v5, #449): the three
// leaf-derived sections (`executive_summary` / `story_highlights` /
// `notable_events`) are arrays of citation units `{ text, source? }`;
// `baseline_observations` is an array of Markdown strings and `period_outlook`
// a plain string. These units are deliberately uncited so the generic tests do
// not trip the citation-source guard; a fabricated `source` is exercised
// separately below. The worker stores the parsed object verbatim and
// recursively scans every string value (incl. unit text) for residual
// tokens / PII.
const AIMER_SECTIONS = {
  executive_summary: [{ text: "Quiet period." }],
  story_highlights: [{ text: "No notable stories." }],
  notable_events: [],
  baseline_observations: ["Baseline stable."],
  period_outlook: "Maintain monitoring.",
};
const AIMER_RESPONSE = {
  sections: JSON.stringify(AIMER_SECTIONS),
  promptVersion: "periodic-1",
  modelActualVersion: "gpt-4o-2026",
};

const EMPTY_RANGES = {
  v4: [],
  v6: [],
} as unknown as Awaited<
  ReturnType<typeof import("@/lib/redaction/load-ranges").loadCustomerRanges>
>;

function makeJob(overrides: Record<string, unknown> = {}) {
  return {
    customer_id: CUSTOMER_ID,
    period: "DAILY" as const,
    bucket_date: "2026-05-26",
    tz: TZ,
    lang: "ENGLISH",
    model_name: "openai",
    model: "gpt-4o",
    generation: 1,
    attempts: 0,
    force_requested_at: null,
    force_requested_by: null,
    cursor_watermark: null,
    cursor_watermark_quality: null,
    ...overrides,
    // biome-ignore lint/suspicious/noExplicitAny: test job shape
  } as any;
}

async function seedState(
  authPool: Pool,
  period: string,
  bucketDate: string,
  status: string,
): Promise<void> {
  await authPool.query(
    `INSERT INTO periodic_report_state (customer_id, period, bucket_date, tz, status)
     VALUES ($1, $2, $3::date, $4, $5)
     ON CONFLICT (customer_id, period, bucket_date, tz)
     DO UPDATE SET status = EXCLUDED.status`,
    [CUSTOMER_ID, period, bucketDate, TZ, status],
  );
}

async function seedQueuedJob(
  authPool: Pool,
  period: string,
  bucketDate: string,
): Promise<void> {
  await authPool.query(
    `INSERT INTO periodic_report_job
       (customer_id, period, bucket_date, tz, lang, model_name, model,
        status, generation, dry_run)
     VALUES ($1, $2, $3::date, $4, 'ENGLISH', 'openai', 'gpt-4o',
             'queued', 1, FALSE)
     ON CONFLICT (customer_id, period, bucket_date, tz, lang, model_name, model)
     DO UPDATE SET status = 'queued', generation = 1, attempts = 0`,
    [CUSTOMER_ID, period, bucketDate, TZ],
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

async function seedEventLeaf(
  customerPool: Pool,
  eventKey: string,
  redactionPolicyVersion: string,
  analysis = "event leaf",
): Promise<void> {
  await customerPool.query(
    `INSERT INTO event_analysis_result
       (aice_id, event_key, lang, model_name, model,
        model_actual_version, prompt_version, generation,
        severity_score, likelihood_score,
        severity_factors, likelihood_factors, ttp_tags,
        priority_tier, analysis_text, redaction_policy_version, requested_by)
     VALUES ('aice-1', $1::numeric, 'ENGLISH', 'openai', 'gpt-4o',
             'mv', 'pv', 1,
             0.6, 0.6,
             '[]'::jsonb, '[]'::jsonb, '["T1110"]'::jsonb,
             'MEDIUM', $2, $3, gen_random_uuid())`,
    [eventKey, analysis, redactionPolicyVersion],
  );
}

// Seed a queued job for an arbitrary variant language (#412 routing tests).
async function seedQueuedJobLang(
  authPool: Pool,
  period: string,
  bucketDate: string,
  lang: string,
): Promise<void> {
  await authPool.query(
    `INSERT INTO periodic_report_job
       (customer_id, period, bucket_date, tz, lang, model_name, model,
        status, generation, dry_run)
     VALUES ($1, $2, $3::date, $4, $5, 'openai', 'gpt-4o',
             'queued', 1, FALSE)
     ON CONFLICT (customer_id, period, bucket_date, tz, lang, model_name, model)
     DO UPDATE SET status = 'queued', generation = 1, attempts = 0,
                   next_due_at = NULL`,
    [CUSTOMER_ID, period, bucketDate, TZ, lang],
  );
}

// Seed an event leaf for an arbitrary variant language.
async function seedEventLeafLang(
  customerPool: Pool,
  eventKey: string,
  lang: string,
  redactionPolicyVersion: string,
  analysis = "event leaf",
): Promise<void> {
  await customerPool.query(
    `INSERT INTO event_analysis_result
       (aice_id, event_key, lang, model_name, model,
        model_actual_version, prompt_version, generation,
        severity_score, likelihood_score,
        severity_factors, likelihood_factors, ttp_tags,
        priority_tier, analysis_text, redaction_policy_version, requested_by)
     VALUES ('aice-1', $1::numeric, $2, 'openai', 'gpt-4o',
             'mv', 'pv', 1,
             0.6, 0.6,
             '[]'::jsonb, '[]'::jsonb, '["T1110"]'::jsonb,
             'MEDIUM', $3, $4, gen_random_uuid())`,
    [eventKey, lang, analysis, redactionPolicyVersion],
  );
}

// Seed an English canonical `periodic_report_result` row citing one event
// ref, the source the non-English routing reads (#412). `restoration_lang`
// is NULL (a native English row).
async function seedCanonicalResult(
  customerPool: Pool,
  period: string,
  bucketDate: string,
  eventKey: string,
): Promise<void> {
  const eventRefs = JSON.stringify([
    { aice_id: "aice-1", event_key: eventKey, generation: 1 },
  ]);
  await customerPool.query(
    `INSERT INTO periodic_report_result
       (customer_id, period, bucket_date, tz, lang, restoration_lang,
        model_name, model, model_actual_version, prompt_version, generation,
        aggregate_severity_score, aggregate_likelihood_score,
        priority_tier, sections_jsonb, input_event_refs, input_story_refs,
        input_hash, redaction_policy_version)
     VALUES ($1, $2, $3::date, $4, 'ENGLISH', NULL,
             'openai', 'gpt-4o', 'canon-mv', 'canon-pv', 1,
             0.6, 0.6,
             'MEDIUM', $5::jsonb, $6::jsonb, '[]'::jsonb,
             'canon-hash', 'v1')`,
    [
      CUSTOMER_ID,
      period,
      bucketDate,
      TZ,
      JSON.stringify(AIMER_SECTIONS),
      eventRefs,
    ],
  );
}

// Seed a story leaf for a given customer + language at the pinned
// (story_id, generation 1, openai/gpt-4o). `customer_id` is part of the story
// leaf identity (the PK), so the owning customer is explicit here.
async function seedStoryLeafLang(
  customerPool: Pool,
  customerId: string,
  storyId: string,
  lang: string,
  analysis = "story leaf",
): Promise<void> {
  await customerPool.query(
    `INSERT INTO story_analysis_result
       (customer_id, story_id, lang, model_name, model,
        model_actual_version, prompt_version, generation,
        severity_score, likelihood_score,
        severity_factors, likelihood_factors, ttp_tags,
        priority_tier, analysis_text, input_event_refs, input_fact_refs,
        input_hash, redaction_policy_version)
     VALUES ($1, $2::bigint, $3, 'openai', 'gpt-4o',
             'mv', 'pv', 1,
             0.8, 0.7,
             '[]'::jsonb, '[]'::jsonb, '["T1078"]'::jsonb,
             'MEDIUM', $4, '[]'::jsonb, '[]'::jsonb, 'h', 'v1')`,
    [customerId, storyId, lang, analysis],
  );
}

// Seed an English canonical `periodic_report_result` row citing one story ref
// (and no events), the source the non-English story routing reads (#412).
async function seedCanonicalResultWithStory(
  customerPool: Pool,
  period: string,
  bucketDate: string,
  storyId: string,
): Promise<void> {
  const storyRefs = JSON.stringify([{ story_id: storyId, generation: 1 }]);
  await customerPool.query(
    `INSERT INTO periodic_report_result
       (customer_id, period, bucket_date, tz, lang, restoration_lang,
        model_name, model, model_actual_version, prompt_version, generation,
        aggregate_severity_score, aggregate_likelihood_score,
        priority_tier, sections_jsonb, input_event_refs, input_story_refs,
        input_hash, redaction_policy_version)
     VALUES ($1, $2, $3::date, $4, 'ENGLISH', NULL,
             'openai', 'gpt-4o', 'canon-mv', 'canon-pv', 1,
             0.6, 0.6,
             'MEDIUM', $5::jsonb, '[]'::jsonb, $6::jsonb,
             'canon-hash', 'v1')`,
    [
      CUSTOMER_ID,
      period,
      bucketDate,
      TZ,
      JSON.stringify(AIMER_SECTIONS),
      storyRefs,
    ],
  );
}

function fakeClientError(status: number): ClientError {
  return new ClientError(
    {
      status,
      errors: [{ message: "x" }],
      headers: new Headers(),
      data: null,
    } as unknown as ClientError["response"],
    { query: "x" },
  );
}

describe.skipIf(!hasPostgres)("periodic report worker (cross-DB)", () => {
  let authDbName: string;
  let authPool: Pool;
  let customerDbName: string;
  let customerPool: Pool;
  let aimerCalls: number;
  const opts = () => ({
    authPool,
    resolveCustomerPool: () => customerPool,
    loadRanges: async () => EMPTY_RANGES,
    callGenerateReport: async () => {
      aimerCalls += 1;
      return AIMER_RESPONSE;
    },
  });

  beforeAll(async () => {
    const auth = await createTestDatabase("report_worker_auth");
    authDbName = auth.dbName;
    authPool = auth.pool;
    await runMigrations(authPool, AUTH_MIGRATIONS_DIR, AUTH_LOCK_ID);

    const cust = await createTestDatabase("report_worker_cust");
    customerDbName = cust.dbName;
    customerPool = cust.pool;
    await runMigrations(
      customerPool,
      CUSTOMER_MIGRATIONS_DIR,
      CUSTOMER_LOCK_ID,
    );

    await authPool.query(
      `INSERT INTO customers (id, external_key, name, database_status, timezone)
       VALUES ($1, 'rw-1', 'RW Customer', 'active', $2)`,
      [CUSTOMER_ID, TZ],
    );
  }, 30_000);

  afterAll(async () => {
    await dropTestDatabase(authDbName, authPool);
    await dropTestDatabase(customerDbName, customerPool);
    await closeAdminPool();
  }, 30_000);

  it("baseline-only bucket: writes result with the sentinel + finalizes the job", async () => {
    aimerCalls = 0;
    await seedState(authPool, "DAILY", "2026-05-26", "ready");
    await seedQueuedJob(authPool, "DAILY", "2026-05-26");

    await processReportJob(makeJob(), opts());

    expect(aimerCalls).toBe(1);
    const { rows } = await customerPool.query<{
      redaction_policy_version: string;
      priority_tier: string;
      input_story_refs: unknown;
      input_event_refs: unknown;
    }>(
      `SELECT redaction_policy_version, priority_tier,
              input_story_refs, input_event_refs
         FROM periodic_report_result
        WHERE customer_id = $1 AND period = 'DAILY'
          AND bucket_date = '2026-05-26' AND tz = $2 AND generation = 1`,
      [CUSTOMER_ID, TZ],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].redaction_policy_version).toBe("baseline-only");
    expect(rows[0].input_story_refs).toEqual([]);
    expect(rows[0].input_event_refs).toEqual([]);

    const { rows: job } = await authPool.query<{ status: string }>(
      `SELECT status FROM periodic_report_job
        WHERE customer_id = $1 AND period = 'DAILY'
          AND bucket_date = '2026-05-26' AND tz = $2`,
      [CUSTOMER_ID, TZ],
    );
    expect(job[0].status).toBe("done");
  });

  it("crash recovery: an existing result row at the captured PK skips the LLM call", async () => {
    aimerCalls = 0;
    // Result row already landed (step 1) but the job is back to queued
    // (step 2 crashed, watchdog re-queued).
    await seedState(authPool, "DAILY", "2026-05-27", "ready");
    await seedQueuedJob(authPool, "DAILY", "2026-05-27");
    await customerPool.query(
      `INSERT INTO periodic_report_result
         (customer_id, period, bucket_date, tz, lang, model_name, model,
          model_actual_version, prompt_version, generation,
          aggregate_severity_score, aggregate_likelihood_score,
          aggregate_ttp_tags, priority_tier, sections_jsonb,
          input_event_refs, input_story_refs, input_hash,
          redaction_policy_version)
       VALUES ($1, 'DAILY', '2026-05-27'::date, $2, 'ENGLISH', 'openai', 'gpt-4o',
               'mv', 'pv', 1,
               0, 0,
               '[]'::jsonb, 'LOW', '{}'::jsonb,
               '[]'::jsonb, '[]'::jsonb, 'h',
               'baseline-only')`,
      [CUSTOMER_ID, TZ],
    );

    await processReportJob(makeJob({ bucket_date: "2026-05-27" }), opts());

    // No second LLM call; the job is finalized from the probe path.
    expect(aimerCalls).toBe(0);
    const { rows: job } = await authPool.query<{
      status: string;
      translation_model_name: string | null;
    }>(
      `SELECT status, translation_model_name FROM periodic_report_job
        WHERE customer_id = $1 AND period = 'DAILY'
          AND bucket_date = '2026-05-27' AND tz = $2`,
      [CUSTOMER_ID, TZ],
    );
    expect(job[0].status).toBe("done");
    // Native existing row (restoration_lang NULL): the idempotent finalize
    // clears any stale translation audit.
    expect(job[0].translation_model_name).toBeNull();
  });

  it("crash recovery: a translated existing row keeps its translation audit", async () => {
    // The translate path writes the customer-DB result row (step 1) and only
    // then writes the auth-DB `translation_*` audit + flips the job to done
    // (step 2). If the worker crashes after step 1, the next attempt hits the
    // result-row probe and finalizes idempotently — and must NOT NULL the
    // audit columns that `recordTranslationAudit` persisted BEFORE step 1
    // (#412 item 6 / round 4). Model that state directly: a translated result
    // row (restoration_lang = ENGLISH) already exists and the job row already
    // carries its translation audit, status back to queued.
    aimerCalls = 0;
    const bucket = "2026-06-30";
    let translateCalls = 0;
    await seedState(authPool, "DAILY", bucket, "ready");
    await customerPool.query(
      `INSERT INTO periodic_report_result
         (customer_id, period, bucket_date, tz, lang, restoration_lang,
          model_name, model, model_actual_version, prompt_version, generation,
          aggregate_severity_score, aggregate_likelihood_score,
          aggregate_ttp_tags, priority_tier, sections_jsonb,
          input_event_refs, input_story_refs, input_hash,
          redaction_policy_version)
       VALUES ($1, 'DAILY', $2::date, $3, 'KOREAN', 'ENGLISH',
               'openai', 'gpt-4o', 'canon-mv', 'canon-pv', 1,
               0.6, 0.6,
               '[]'::jsonb, 'MEDIUM', $4::jsonb,
               '[]'::jsonb, '[]'::jsonb, 'canon-hash',
               'v1')`,
      [CUSTOMER_ID, bucket, TZ, JSON.stringify(AIMER_SECTIONS)],
    );
    await authPool.query(
      `INSERT INTO periodic_report_job
         (customer_id, period, bucket_date, tz, lang, model_name, model,
          status, generation, dry_run,
          translation_model_name, translation_model, translation_prompt_version)
       VALUES ($1, 'DAILY', $2::date, $3, 'KOREAN', 'openai', 'gpt-4o',
               'queued', 1, FALSE,
               'openai', 'gpt-4o', 'translate-pv-1')`,
      [CUSTOMER_ID, bucket, TZ],
    );

    await processReportJob(makeJob({ bucket_date: bucket, lang: "KOREAN" }), {
      authPool,
      resolveCustomerPool: () => customerPool,
      loadRanges: async () => EMPTY_RANGES,
      callGenerateReport: async () => {
        aimerCalls += 1;
        return AIMER_RESPONSE;
      },
      callTranslateReport: async () => {
        translateCalls += 1;
        return AIMER_RESPONSE;
      },
    });

    // No LLM call of either kind — finalized from the probe.
    expect(aimerCalls).toBe(0);
    expect(translateCalls).toBe(0);

    // Done, with the translation audit columns preserved (not NULLed).
    const { rows: job } = await authPool.query<{
      status: string;
      translation_model_name: string | null;
      translation_model: string | null;
      translation_prompt_version: string | null;
    }>(
      `SELECT status, translation_model_name, translation_model,
              translation_prompt_version
         FROM periodic_report_job
        WHERE customer_id = $1 AND period = 'DAILY'
          AND bucket_date = $2::date AND tz = $3 AND lang = 'KOREAN'`,
      [CUSTOMER_ID, bucket, TZ],
    );
    expect(job[0].status).toBe("done");
    expect(job[0].translation_model_name).toBe("openai");
    expect(job[0].translation_model).toBe("gpt-4o");
    expect(job[0].translation_prompt_version).toBe("translate-pv-1");
  });

  it("requeues (attempts++) on a retryable 5xx, no result row written", async () => {
    aimerCalls = 0;
    await seedState(authPool, "DAILY", "2026-05-28", "ready");
    await seedQueuedJob(authPool, "DAILY", "2026-05-28");

    await processReportJob(makeJob({ bucket_date: "2026-05-28" }), {
      ...opts(),
      callGenerateReport: async () => {
        throw fakeClientError(503);
      },
    });

    const { rows: job } = await authPool.query<{
      status: string;
      attempts: number;
      last_error: string | null;
    }>(
      `SELECT status, attempts, last_error FROM periodic_report_job
        WHERE customer_id = $1 AND period = 'DAILY'
          AND bucket_date = '2026-05-28' AND tz = $2`,
      [CUSTOMER_ID, TZ],
    );
    expect(job[0].status).toBe("queued");
    expect(job[0].attempts).toBe(1);
    expect(job[0].last_error).toBe("aimer_5xx");
    const { rows: result } = await customerPool.query(
      `SELECT 1 FROM periodic_report_result
        WHERE customer_id = $1 AND period = 'DAILY'
          AND bucket_date = '2026-05-28' AND tz = $2`,
      [CUSTOMER_ID, TZ],
    );
    expect(result).toHaveLength(0);
  });

  it("fails the job (no retry) on a fatal 4xx", async () => {
    aimerCalls = 0;
    await seedState(authPool, "DAILY", "2026-05-29", "ready");
    await seedQueuedJob(authPool, "DAILY", "2026-05-29");

    await processReportJob(makeJob({ bucket_date: "2026-05-29" }), {
      ...opts(),
      callGenerateReport: async () => {
        throw fakeClientError(400);
      },
    });

    const { rows: job } = await authPool.query<{
      status: string;
      attempts: number;
      last_error: string | null;
    }>(
      `SELECT status, attempts, last_error FROM periodic_report_job
        WHERE customer_id = $1 AND period = 'DAILY'
          AND bucket_date = '2026-05-29' AND tz = $2`,
      [CUSTOMER_ID, TZ],
    );
    expect(job[0].status).toBe("failed");
    expect(job[0].attempts).toBe(1);
    expect(job[0].last_error).toBe("aimer_4xx");
  });

  it("fails on a hallucinated leak before any result-row INSERT", async () => {
    await seedState(authPool, "DAILY", "2026-05-30", "ready");
    await seedQueuedJob(authPool, "DAILY", "2026-05-30");

    await processReportJob(makeJob({ bucket_date: "2026-05-30" }), {
      ...opts(),
      callGenerateReport: async () => ({
        ...AIMER_RESPONSE,
        // Plaintext email PII the LLM should never have been able to emit,
        // buried in one section of the JSON payload.
        sections: JSON.stringify({
          ...AIMER_SECTIONS,
          executive_summary: "Contact analyst@example.com about this.",
        }),
      }),
    });

    const { rows: job } = await authPool.query<{
      status: string;
      last_error: string | null;
    }>(
      `SELECT status, last_error FROM periodic_report_job
        WHERE customer_id = $1 AND period = 'DAILY'
          AND bucket_date = '2026-05-30' AND tz = $2`,
      [CUSTOMER_ID, TZ],
    );
    expect(job[0].status).toBe("failed");
    expect(job[0].last_error).toBe("hallucination_detected");
    const { rows: result } = await customerPool.query(
      `SELECT 1 FROM periodic_report_result
        WHERE customer_id = $1 AND period = 'DAILY'
          AND bucket_date = '2026-05-30' AND tz = $2`,
      [CUSTOMER_ID, TZ],
    );
    expect(result).toHaveLength(0);
  });

  it("fails on a fabricated citation source before any result-row INSERT (#449)", async () => {
    await seedState(authPool, "DAILY", "2026-05-31", "ready");
    await seedQueuedJob(authPool, "DAILY", "2026-05-31");

    // A baseline-only report has no input leaves, so ANY unit `source` is
    // fabricated. aimer-web's defense-in-depth guard must reject it and refuse
    // to persist a row carrying an out-of-bundle citation.
    await processReportJob(makeJob({ bucket_date: "2026-05-31" }), {
      ...opts(),
      callGenerateReport: async () => ({
        ...AIMER_RESPONSE,
        sections: JSON.stringify({
          ...AIMER_SECTIONS,
          executive_summary: [
            {
              text: "A claim citing a leaf never in the bundle.",
              source: { type: "story", story_id: "does-not-exist" },
            },
          ],
        }),
      }),
    });

    const { rows: job } = await authPool.query<{
      status: string;
      last_error: string | null;
    }>(
      `SELECT status, last_error FROM periodic_report_job
        WHERE customer_id = $1 AND period = 'DAILY'
          AND bucket_date = '2026-05-31' AND tz = $2`,
      [CUSTOMER_ID, TZ],
    );
    expect(job[0].status).toBe("failed");
    expect(job[0].last_error).toBe("citation_source_invalid");
    const { rows: result } = await customerPool.query(
      `SELECT 1 FROM periodic_report_result
        WHERE customer_id = $1 AND period = 'DAILY'
          AND bucket_date = '2026-05-31' AND tz = $2`,
      [CUSTOMER_ID, TZ],
    );
    expect(result).toHaveLength(0);
  });

  it("aborts with missing_redaction_policy_version and no LLM call", async () => {
    aimerCalls = 0;
    await seedState(authPool, "DAILY", "2026-06-01", "ready");
    await seedQueuedJob(authPool, "DAILY", "2026-06-01");
    // One eligible event leaf in the bucket window with an EMPTY policy.
    await seedBaselineEvent(customerPool, "8001", "2026-06-01T02:00:00Z");
    await seedEventLeaf(customerPool, "8001", "");

    await processReportJob(makeJob({ bucket_date: "2026-06-01" }), opts());

    expect(aimerCalls).toBe(0);
    const { rows: job } = await authPool.query<{
      status: string;
      last_error: string | null;
    }>(
      `SELECT status, last_error FROM periodic_report_job
        WHERE customer_id = $1 AND period = 'DAILY'
          AND bucket_date = '2026-06-01' AND tz = $2`,
      [CUSTOMER_ID, TZ],
    );
    expect(job[0].status).toBe("failed");
    expect(job[0].last_error).toBe("missing_redaction_policy_version");
  });

  it("aborts with mismatched_redaction_policy_version and no LLM call", async () => {
    aimerCalls = 0;
    await seedState(authPool, "DAILY", "2026-06-02", "ready");
    await seedQueuedJob(authPool, "DAILY", "2026-06-02");
    // Two eligible leaves disagreeing on policy version.
    await seedBaselineEvent(customerPool, "8002", "2026-06-02T02:00:00Z");
    await seedEventLeaf(customerPool, "8002", "policy-A");
    await seedBaselineEvent(customerPool, "8003", "2026-06-02T02:00:00Z");
    await seedEventLeaf(customerPool, "8003", "policy-B");

    await processReportJob(makeJob({ bucket_date: "2026-06-02" }), opts());

    expect(aimerCalls).toBe(0);
    const { rows: job } = await authPool.query<{
      status: string;
      last_error: string | null;
    }>(
      `SELECT status, last_error FROM periodic_report_job
        WHERE customer_id = $1 AND period = 'DAILY'
          AND bucket_date = '2026-06-02' AND tz = $2`,
      [CUSTOMER_ID, TZ],
    );
    expect(job[0].status).toBe("failed");
    expect(job[0].last_error).toBe("mismatched_redaction_policy_version");
  });

  it("concurrent force bumps generation: finalize no-ops, new generation stays queued", async () => {
    aimerCalls = 0;
    await seedState(authPool, "DAILY", "2026-06-03", "ready");
    await seedQueuedJob(authPool, "DAILY", "2026-06-03");

    // Race a force-regenerate in between the LLM call and the finalize:
    // it bumps the job row to generation 2 / queued while the worker is
    // still holding captured generation 1.
    await processReportJob(makeJob({ bucket_date: "2026-06-03" }), {
      ...opts(),
      callGenerateReport: async () => {
        aimerCalls += 1;
        await authPool.query(
          `UPDATE periodic_report_job
              SET generation = 2, status = 'queued', attempts = 0,
                  force_requested_at = NOW(), updated_at = NOW()
            WHERE customer_id = $1 AND period = 'DAILY'
              AND bucket_date = '2026-06-03' AND tz = $2`,
          [CUSTOMER_ID, TZ],
        );
        return AIMER_RESPONSE;
      },
    });

    // The result row at the captured generation 1 still landed.
    const { rows: result } = await customerPool.query<{ generation: number }>(
      `SELECT generation FROM periodic_report_result
        WHERE customer_id = $1 AND period = 'DAILY'
          AND bucket_date = '2026-06-03' AND tz = $2
        ORDER BY generation`,
      [CUSTOMER_ID, TZ],
    );
    expect(result.map((r) => r.generation)).toEqual([1]);

    // The finalize keyed on (generation = 1 AND status = 'processing')
    // matched zero rows, so the force-queued generation 2 is untouched
    // and gets picked up on the next tick.
    const { rows: job } = await authPool.query<{
      status: string;
      generation: number;
    }>(
      `SELECT status, generation FROM periodic_report_job
        WHERE customer_id = $1 AND period = 'DAILY'
          AND bucket_date = '2026-06-03' AND tz = $2`,
      [CUSTOMER_ID, TZ],
    );
    expect(job[0].status).toBe("queued");
    expect(job[0].generation).toBe(2);
  });

  it("stale timed-out attempt cannot fail a later re-claimed attempt (claim marker)", async () => {
    // Worker A claims generation 1, then the watchdog times it out and a
    // second worker re-claims the same generation (modeled here by
    // overwriting `processing_started_at` mid-call while keeping the row
    // `processing`). Worker A then returns on a fatal path. Its `failJob`
    // must NO-OP because the captured claim marker no longer matches —
    // the later attempt's `processing` state is preserved, not flipped to
    // `failed` (#297 review round 5, item 1).
    aimerCalls = 0;
    await seedState(authPool, "DAILY", "2026-06-04", "ready");
    await seedQueuedJob(authPool, "DAILY", "2026-06-04");

    await processReportJob(makeJob({ bucket_date: "2026-06-04" }), {
      ...opts(),
      callGenerateReport: async () => {
        // Simulate watchdog requeue + re-claim by another worker: the row
        // stays `processing` but under a different claim marker.
        await authPool.query(
          `UPDATE periodic_report_job
              SET processing_started_at = TIMESTAMPTZ '2020-01-01 00:00:00+00'
            WHERE customer_id = $1 AND period = 'DAILY'
              AND bucket_date = '2026-06-04' AND tz = $2`,
          [CUSTOMER_ID, TZ],
        );
        throw fakeClientError(400);
      },
    });

    // failJob matched zero rows: the row is still `processing` under the
    // newer claim marker, with no error stamped by the stale attempt.
    const { rows: job } = await authPool.query<{
      status: string;
      last_error: string | null;
      processing_started_at: string;
    }>(
      `SELECT status, last_error, processing_started_at::text AS processing_started_at
         FROM periodic_report_job
        WHERE customer_id = $1 AND period = 'DAILY'
          AND bucket_date = '2026-06-04' AND tz = $2`,
      [CUSTOMER_ID, TZ],
    );
    expect(job[0].status).toBe("processing");
    expect(job[0].last_error).toBeNull();
    expect(job[0].processing_started_at).toContain("2020-01-01");
  });

  it("suppresses the result write when the parent archives during the LLM call", async () => {
    // The tz-change trigger archives the parent state after the claim and
    // the pre-call re-check pass, while the LLM call is in flight. The
    // pre-insert re-check must catch it: no result row for the now-terminal
    // state, and the claimed job is released back to queued, not finalized
    // (#297 review round 4, item 3).
    aimerCalls = 0;
    await seedState(authPool, "DAILY", "2026-06-05", "ready");
    await seedQueuedJob(authPool, "DAILY", "2026-06-05");

    await processReportJob(makeJob({ bucket_date: "2026-06-05" }), {
      ...opts(),
      callGenerateReport: async () => {
        aimerCalls += 1;
        await seedState(authPool, "DAILY", "2026-06-05", "archived");
        return AIMER_RESPONSE;
      },
    });

    const { rows: result } = await customerPool.query(
      `SELECT 1 FROM periodic_report_result
        WHERE customer_id = $1 AND period = 'DAILY'
          AND bucket_date = '2026-06-05' AND tz = $2`,
      [CUSTOMER_ID, TZ],
    );
    expect(result).toHaveLength(0);

    const { rows: job } = await authPool.query<{ status: string }>(
      `SELECT status FROM periodic_report_job
        WHERE customer_id = $1 AND period = 'DAILY'
          AND bucket_date = '2026-06-05' AND tz = $2`,
      [CUSTOMER_ID, TZ],
    );
    expect(job[0].status).toBe("queued");
  });

  it("pickup skips a queued job whose parent state archived after queueing", async () => {
    // A timezone change archives the old-tz state without deleting its
    // queued jobs. The runtime pickup path must not call the LLM or write
    // a result for a terminal archived parent (#297 review round 2,
    // item 2).
    aimerCalls = 0;
    // Park any jobs left queued by earlier cases so this tick only sees
    // the archived-parent job under test.
    await authPool.query(
      `UPDATE periodic_report_job SET status = 'done' WHERE status = 'queued'`,
    );
    await seedState(authPool, "DAILY", "2026-06-04", "ready");
    await seedQueuedJob(authPool, "DAILY", "2026-06-04");
    // Archive the parent after the job is already queued.
    await seedState(authPool, "DAILY", "2026-06-04", "archived");

    const picked = await tickReportJobsOnce(authPool, 10, opts());

    expect(picked).toBe(0);
    expect(aimerCalls).toBe(0);

    const { rows: result } = await customerPool.query(
      `SELECT 1 FROM periodic_report_result
        WHERE customer_id = $1 AND period = 'DAILY'
          AND bucket_date = '2026-06-04' AND tz = $2`,
      [CUSTOMER_ID, TZ],
    );
    expect(result).toHaveLength(0);

    // The job is left untouched (still queued) — not finalized.
    const { rows: job } = await authPool.query<{ status: string }>(
      `SELECT status FROM periodic_report_job
        WHERE customer_id = $1 AND period = 'DAILY'
          AND bucket_date = '2026-06-04' AND tz = $2`,
      [CUSTOMER_ID, TZ],
    );
    expect(job[0].status).toBe("queued");
  });

  it.each([
    { period: "WEEKLY", bucket: "2026-05-25" },
    { period: "MONTHLY", bucket: "2026-05-01" },
  ])("pickup processes a queued $period job (Phase 2 LIVE/DAILY filter lifted in #298)", async ({
    period,
    bucket,
  }) => {
    // The Phase 2 pickup filter (`pickQueuedReportJobs`) restricted to
    // LIVE/DAILY; #298 widened it to all four periods. Prove a queued
    // WEEKLY/MONTHLY job under a `ready` parent is actually claimed by
    // the runtime tick, calls the LLM, and finalizes — not silently
    // skipped by the period filter.
    aimerCalls = 0;
    // Isolate this tick to the job under test (earlier cases leave
    // queued rows behind).
    await authPool.query(
      `UPDATE periodic_report_job SET status = 'done' WHERE status = 'queued'`,
    );
    await seedState(authPool, period, bucket, "ready");
    await seedQueuedJob(authPool, period, bucket);

    const picked = await tickReportJobsOnce(authPool, 10, opts());

    expect(picked).toBe(1);
    expect(aimerCalls).toBe(1);

    const { rows: result } = await customerPool.query<{
      redaction_policy_version: string;
    }>(
      `SELECT redaction_policy_version FROM periodic_report_result
          WHERE customer_id = $1 AND period = $2
            AND bucket_date = $3::date AND tz = $4 AND generation = 1`,
      [CUSTOMER_ID, period, bucket, TZ],
    );
    expect(result).toHaveLength(1);

    const { rows: job } = await authPool.query<{ status: string }>(
      `SELECT status FROM periodic_report_job
          WHERE customer_id = $1 AND period = $2
            AND bucket_date = $3::date AND tz = $4`,
      [CUSTOMER_ID, period, bucket, TZ],
    );
    expect(job[0].status).toBe("done");
  });

  it("LIVE next_due_at re-queue skips an archived parent state row", async () => {
    // Archived LIVE state with a done LIVE job whose cadence elapsed.
    await seedState(authPool, "LIVE", LIVE_BUCKET, "archived");
    await authPool.query(
      `INSERT INTO periodic_report_job
         (customer_id, period, bucket_date, tz, lang, model_name, model,
          status, generation, dry_run, last_generated_at, next_due_at)
       VALUES ($1, 'LIVE', $2::date, $3, 'ENGLISH', 'openai', 'gpt-4o',
               'done', 3, FALSE,
               NOW() - INTERVAL '2 hours', NOW() - INTERVAL '1 hour')
       ON CONFLICT (customer_id, period, bucket_date, tz, lang, model_name, model)
       DO UPDATE SET status = 'done', generation = 3,
                     next_due_at = NOW() - INTERVAL '1 hour'`,
      [CUSTOMER_ID, LIVE_BUCKET, TZ],
    );

    const client = await authPool.connect();
    try {
      await requeueLiveReportJobs(client, new Date().toISOString());
    } finally {
      client.release();
    }

    const { rows } = await authPool.query<{
      status: string;
      generation: number;
    }>(
      `SELECT status, generation FROM periodic_report_job
        WHERE customer_id = $1 AND period = 'LIVE'
          AND bucket_date = $2::date AND tz = $3`,
      [CUSTOMER_ID, LIVE_BUCKET, TZ],
    );
    // Archived parent ⇒ NOT re-queued: still done, generation unchanged.
    expect(rows[0].status).toBe("done");
    expect(rows[0].generation).toBe(3);
  });

  it("LIVE next_due_at re-queue does not auto-bump a job at MAX_GENERATION", async () => {
    // The issue locks "Force is allowed past ANALYSIS_MAX_GENERATION
    // (auto-requeue is not)". The LIVE cadence re-queue is an automatic
    // path, so a done LIVE job already at the cap whose next_due_at has
    // elapsed must stay done — only an operator force-regenerate may push
    // it past the cap.
    await seedState(authPool, "LIVE", LIVE_BUCKET, "ready");
    await authPool.query(
      `INSERT INTO periodic_report_job
         (customer_id, period, bucket_date, tz, lang, model_name, model,
          status, generation, dry_run, last_generated_at, next_due_at)
       VALUES ($1, 'LIVE', $2::date, $3, 'ENGLISH', 'openai', 'gpt-4o',
               'done', $4, FALSE,
               NOW() - INTERVAL '2 hours', NOW() - INTERVAL '1 hour')
       ON CONFLICT (customer_id, period, bucket_date, tz, lang, model_name, model)
       DO UPDATE SET status = 'done', generation = $4,
                     next_due_at = NOW() - INTERVAL '1 hour'`,
      [CUSTOMER_ID, LIVE_BUCKET, TZ, MAX_GENERATION],
    );

    const client = await authPool.connect();
    try {
      await requeueLiveReportJobs(client, new Date().toISOString());
    } finally {
      client.release();
    }

    const { rows } = await authPool.query<{
      status: string;
      generation: number;
    }>(
      `SELECT status, generation FROM periodic_report_job
        WHERE customer_id = $1 AND period = 'LIVE'
          AND bucket_date = $2::date AND tz = $3`,
      [CUSTOMER_ID, LIVE_BUCKET, TZ],
    );
    // At the cap ⇒ NOT auto-re-queued: still done, generation unchanged.
    expect(rows[0].status).toBe("done");
    expect(rows[0].generation).toBe(MAX_GENERATION);
  });

  it("LIVE cadence re-queue clears stale force metadata from a prior force", async () => {
    // After an operator force-regenerates once, the force_requested_* columns
    // are sticky on the single per-variant row. The cadence-driven bump is an
    // automatic generation and must not inherit the prior operator's force
    // attribution (#297 review round 7, item 1).
    const OPERATOR = "00000000-0000-0000-0000-0000000000a1";
    await seedState(authPool, "LIVE", LIVE_BUCKET, "ready");
    await authPool.query(
      `INSERT INTO periodic_report_job
         (customer_id, period, bucket_date, tz, lang, model_name, model,
          status, generation, dry_run, last_generated_at, next_due_at,
          force_requested_at, force_requested_by)
       VALUES ($1, 'LIVE', $2::date, $3, 'ENGLISH', 'openai', 'gpt-4o',
               'done', 2, FALSE,
               NOW() - INTERVAL '2 hours', NOW() - INTERVAL '1 hour',
               NOW() - INTERVAL '2 hours', $4::uuid)
       ON CONFLICT (customer_id, period, bucket_date, tz, lang, model_name, model)
       DO UPDATE SET status = 'done', generation = 2,
                     next_due_at = NOW() - INTERVAL '1 hour',
                     force_requested_at = NOW() - INTERVAL '2 hours',
                     force_requested_by = $4::uuid`,
      [CUSTOMER_ID, LIVE_BUCKET, TZ, OPERATOR],
    );

    const client = await authPool.connect();
    try {
      await requeueLiveReportJobs(client, new Date().toISOString());
    } finally {
      client.release();
    }

    const { rows } = await authPool.query<{
      status: string;
      generation: number;
      force_requested_at: Date | null;
      force_requested_by: string | null;
    }>(
      `SELECT status, generation, force_requested_at,
              force_requested_by::text AS force_requested_by
         FROM periodic_report_job
        WHERE customer_id = $1 AND period = 'LIVE'
          AND bucket_date = $2::date AND tz = $3`,
      [CUSTOMER_ID, LIVE_BUCKET, TZ],
    );
    // Re-queued (generation bumped) but the force attribution is cleared so
    // the next generation is classified as automatic.
    expect(rows[0].status).toBe("queued");
    expect(rows[0].generation).toBe(3);
    expect(rows[0].force_requested_at).toBeNull();
    expect(rows[0].force_requested_by).toBeNull();
  });

  it("dirty auto-requeue clears stale force metadata from a prior force", async () => {
    // Source-driven (dirty) requeue path: same sticky-column hazard as the
    // LIVE cadence path. A dirty state with an existing done job carrying
    // prior force metadata must bump generation and reset the force columns
    // (#297 review round 7, item 1).
    const OPERATOR = "00000000-0000-0000-0000-0000000000a2";
    const DIRTY_BUCKET = "2026-05-27";
    await seedState(authPool, "DAILY", DIRTY_BUCKET, "dirty");
    await authPool.query(
      `INSERT INTO periodic_report_job
         (customer_id, period, bucket_date, tz, lang, model_name, model,
          status, generation, dry_run,
          force_requested_at, force_requested_by)
       VALUES ($1, 'DAILY', $2::date, $3, 'ENGLISH', 'openai', 'gpt-4o',
               'done', 2, FALSE,
               NOW() - INTERVAL '2 hours', $4::uuid)
       ON CONFLICT (customer_id, period, bucket_date, tz, lang, model_name, model)
       DO UPDATE SET status = 'done', generation = 2,
                     force_requested_at = NOW() - INTERVAL '2 hours',
                     force_requested_by = $4::uuid`,
      [CUSTOMER_ID, DIRTY_BUCKET, TZ, OPERATOR],
    );

    const client = await authPool.connect();
    try {
      await seedRealReportJobs(client, 10, new Date().toISOString());
    } finally {
      client.release();
    }

    const { rows } = await authPool.query<{
      status: string;
      generation: number;
      force_requested_at: Date | null;
      force_requested_by: string | null;
    }>(
      `SELECT status, generation, force_requested_at,
              force_requested_by::text AS force_requested_by
         FROM periodic_report_job
        WHERE customer_id = $1 AND period = 'DAILY'
          AND bucket_date = $2::date AND tz = $3`,
      [CUSTOMER_ID, DIRTY_BUCKET, TZ],
    );
    expect(rows[0].status).toBe("queued");
    expect(rows[0].generation).toBe(3);
    expect(rows[0].force_requested_at).toBeNull();
    expect(rows[0].force_requested_by).toBeNull();
  });

  it("dirty auto-requeue bumps an existing non-default variant job", async () => {
    // A force-created non-default variant (Korean, here) must also be
    // re-queued when its bucket's source data changes. Bumping only the
    // default English job left the Korean periodic_report_result serving a
    // stale generation indefinitely (#297 review round 8, item 1).
    const OPERATOR = "00000000-0000-0000-0000-0000000000a3";
    const DIRTY_BUCKET = "2026-06-09";
    await seedState(authPool, "DAILY", DIRTY_BUCKET, "dirty");
    // Default English job in `done` (created by the normal worker path).
    await authPool.query(
      `INSERT INTO periodic_report_job
         (customer_id, period, bucket_date, tz, lang, model_name, model,
          status, generation, dry_run)
       VALUES ($1, 'DAILY', $2::date, $3, 'ENGLISH', 'openai', 'gpt-4o',
               'done', 1, FALSE)`,
      [CUSTOMER_ID, DIRTY_BUCKET, TZ],
    );
    // Operator-forced Korean variant in `done`, carrying force metadata.
    await authPool.query(
      `INSERT INTO periodic_report_job
         (customer_id, period, bucket_date, tz, lang, model_name, model,
          status, generation, dry_run,
          force_requested_at, force_requested_by)
       VALUES ($1, 'DAILY', $2::date, $3, 'KOREAN', 'openai', 'gpt-4o',
               'done', 2, FALSE,
               NOW() - INTERVAL '2 hours', $4::uuid)`,
      [CUSTOMER_ID, DIRTY_BUCKET, TZ, OPERATOR],
    );

    const client = await authPool.connect();
    try {
      await seedRealReportJobs(client, 10, new Date().toISOString());
    } finally {
      client.release();
    }

    const { rows } = await authPool.query<{
      lang: string;
      status: string;
      generation: number;
      force_requested_at: Date | null;
      force_requested_by: string | null;
    }>(
      `SELECT lang, status, generation, force_requested_at,
              force_requested_by::text AS force_requested_by
         FROM periodic_report_job
        WHERE customer_id = $1 AND period = 'DAILY'
          AND bucket_date = $2::date AND tz = $3
        ORDER BY lang`,
      [CUSTOMER_ID, DIRTY_BUCKET, TZ],
    );
    const byLang = new Map(rows.map((r) => [r.lang, r]));

    // Default English variant re-queued (generation 1 → 2).
    const english = byLang.get("ENGLISH");
    expect(english?.status).toBe("queued");
    expect(english?.generation).toBe(2);

    // Non-default Korean variant ALSO re-queued (generation 2 → 3), with the
    // stale force metadata cleared so the next generation is automatic.
    const korean = byLang.get("KOREAN");
    expect(korean?.status).toBe("queued");
    expect(korean?.generation).toBe(3);
    expect(korean?.force_requested_at).toBeNull();
    expect(korean?.force_requested_by).toBeNull();

    // The parent state returns to `ready`.
    const { rows: stateRows } = await authPool.query<{ status: string }>(
      `SELECT status FROM periodic_report_state
        WHERE customer_id = $1 AND period = 'DAILY'
          AND bucket_date = $2::date AND tz = $3`,
      [CUSTOMER_ID, DIRTY_BUCKET, TZ],
    );
    expect(stateRows[0].status).toBe("ready");
  });

  it("dirty LIVE row past next_due_at is bumped once across a full tick, not twice", async () => {
    // A dirty LIVE state whose done job's cadence has also elapsed used to be
    // bumped twice in one tick: once by `requeueLiveReportJobs` (cadence) and
    // again by `seedRealReportJobs`' dirty branch. That burned two automatic
    // generations for one invalidation, could hit ANALYSIS_MAX_GENERATION a
    // cycle early, and skipped a generation that never produced a result
    // (#297 review round 9, item 1). The cadence path now excludes dirty
    // parents, so the two automatic signals coalesce into a single bump.
    await seedState(authPool, "LIVE", LIVE_BUCKET, "dirty");
    await authPool.query(
      `INSERT INTO periodic_report_job
         (customer_id, period, bucket_date, tz, lang, model_name, model,
          status, generation, dry_run, last_generated_at, next_due_at)
       VALUES ($1, 'LIVE', $2::date, $3, 'ENGLISH', 'openai', 'gpt-4o',
               'done', 3, FALSE,
               NOW() - INTERVAL '2 hours', NOW() - INTERVAL '1 hour')
       ON CONFLICT (customer_id, period, bucket_date, tz, lang, model_name, model)
       DO UPDATE SET status = 'done', generation = 3,
                     next_due_at = NOW() - INTERVAL '1 hour'`,
      [CUSTOMER_ID, LIVE_BUCKET, TZ],
    );

    // Run the two automatic steps in the exact order tickPeriodicStates does.
    const now = new Date().toISOString();
    const client = await authPool.connect();
    try {
      await requeueLiveReportJobs(client, now);
      await seedRealReportJobs(client, 10, now);
    } finally {
      client.release();
    }

    const { rows } = await authPool.query<{
      status: string;
      generation: number;
    }>(
      `SELECT status, generation FROM periodic_report_job
        WHERE customer_id = $1 AND period = 'LIVE'
          AND bucket_date = $2::date AND tz = $3`,
      [CUSTOMER_ID, LIVE_BUCKET, TZ],
    );
    // Exactly one automatic generation consumed: 3 → 4 (not 3 → 5).
    expect(rows[0].status).toBe("queued");
    expect(rows[0].generation).toBe(4);

    // The dirty state is settled back to ready by the seed step.
    const { rows: stateRows } = await authPool.query<{ status: string }>(
      `SELECT status FROM periodic_report_state
        WHERE customer_id = $1 AND period = 'LIVE'
          AND bucket_date = $2::date AND tz = $3`,
      [CUSTOMER_ID, LIVE_BUCKET, TZ],
    );
    expect(stateRows[0].status).toBe("ready");
  });

  // --- #412: native-vs-translate routing + canonical defer guard --------

  it("non-English defers (non-terminal) when the English canonical is absent", async () => {
    aimerCalls = 0;
    const bucket = "2026-06-10";
    let translateCalls = 0;
    await seedState(authPool, "DAILY", bucket, "ready");
    await seedQueuedJobLang(authPool, "DAILY", bucket, "KOREAN");

    await processReportJob(makeJob({ bucket_date: bucket, lang: "KOREAN" }), {
      authPool,
      resolveCustomerPool: () => customerPool,
      loadRanges: async () => EMPTY_RANGES,
      callGenerateReport: async () => {
        aimerCalls += 1;
        return AIMER_RESPONSE;
      },
      callTranslateReport: async () => {
        translateCalls += 1;
        return AIMER_RESPONSE;
      },
    });

    // No LLM call of either kind.
    expect(aimerCalls).toBe(0);
    expect(translateCalls).toBe(0);

    // Non-terminal defer: still queued, attempts NOT incremented, a future
    // next_due_at set so the picker won't hot-spin.
    const { rows } = await authPool.query<{
      status: string;
      attempts: number;
      last_error: string | null;
      future: boolean;
    }>(
      `SELECT status, attempts, last_error,
              (next_due_at IS NOT NULL AND next_due_at > NOW()) AS future
         FROM periodic_report_job
        WHERE customer_id = $1 AND period = 'DAILY'
          AND bucket_date = $2::date AND tz = $3 AND lang = 'KOREAN'`,
      [CUSTOMER_ID, bucket, TZ],
    );
    expect(rows[0].status).toBe("queued");
    expect(rows[0].attempts).toBe(0);
    expect(rows[0].last_error).toBe("english_canonical_not_ready");
    expect(rows[0].future).toBe(true);

    // No result row was written for the deferred variant.
    const { rows: res } = await customerPool.query(
      `SELECT 1 FROM periodic_report_result
        WHERE customer_id = $1 AND period = 'DAILY'
          AND bucket_date = $2::date AND tz = $3 AND lang = 'KOREAN'`,
      [CUSTOMER_ID, bucket, TZ],
    );
    expect(res).toHaveLength(0);
  });

  it("non-English defers when only a PRIOR-generation English canonical exists", async () => {
    // Generation-aware canonical lookup (review round 1). A dirty / force
    // regenerate bumps every variant job to generation 2, but the prior
    // English generation 1 result stays `superseded_at IS NULL` until the
    // English generation 2 row is written. If a Korean generation 2 job is
    // processed before English generation 2, the canonical lookup must NOT
    // fall back to the stale generation 1 row (generating/translating Korean
    // gen 2 from gen-1 refs/sections) — it must defer until the gen-2
    // canonical exists.
    aimerCalls = 0;
    const bucket = "2026-06-15";
    const eventKey = "7001";
    let translateCalls = 0;
    await seedState(authPool, "DAILY", bucket, "ready");
    await seedBaselineEvent(customerPool, eventKey, `${bucket}T01:00:00Z`);
    // Leaves exist in both langs at the pinned (event_key, generation), so
    // WITHOUT the generation guard the buggy lookup would read the gen-1
    // canonical and generate Korean gen 2 natively instead of deferring.
    await seedEventLeafLang(customerPool, eventKey, "ENGLISH", "v1");
    await seedEventLeafLang(customerPool, eventKey, "KOREAN", "v1");
    // Only a generation-1 English canonical exists.
    await seedCanonicalResult(customerPool, "DAILY", bucket, eventKey);
    // Korean job bumped to generation 2 (as a dirty/force requeue would).
    await authPool.query(
      `INSERT INTO periodic_report_job
         (customer_id, period, bucket_date, tz, lang, model_name, model,
          status, generation, dry_run)
       VALUES ($1, 'DAILY', $2::date, $3, 'KOREAN', 'openai', 'gpt-4o',
               'queued', 2, FALSE)
       ON CONFLICT (customer_id, period, bucket_date, tz, lang, model_name, model)
       DO UPDATE SET status = 'queued', generation = 2, attempts = 0,
                     next_due_at = NULL`,
      [CUSTOMER_ID, bucket, TZ],
    );

    await processReportJob(
      makeJob({ bucket_date: bucket, lang: "KOREAN", generation: 2 }),
      {
        authPool,
        resolveCustomerPool: () => customerPool,
        loadRanges: async () => EMPTY_RANGES,
        callGenerateReport: async () => {
          aimerCalls += 1;
          return AIMER_RESPONSE;
        },
        callTranslateReport: async () => {
          translateCalls += 1;
          return AIMER_RESPONSE;
        },
      },
    );

    // Deferred, not generated/translated off the stale gen-1 canonical.
    expect(aimerCalls).toBe(0);
    expect(translateCalls).toBe(0);

    const { rows } = await authPool.query<{
      status: string;
      attempts: number;
      last_error: string | null;
      future: boolean;
    }>(
      `SELECT status, attempts, last_error,
              (next_due_at IS NOT NULL AND next_due_at > NOW()) AS future
         FROM periodic_report_job
        WHERE customer_id = $1 AND period = 'DAILY'
          AND bucket_date = $2::date AND tz = $3 AND lang = 'KOREAN'`,
      [CUSTOMER_ID, bucket, TZ],
    );
    expect(rows[0].status).toBe("queued");
    expect(rows[0].attempts).toBe(0);
    expect(rows[0].last_error).toBe("english_canonical_not_ready");
    expect(rows[0].future).toBe(true);

    // No Korean result row was written at the bumped generation.
    const { rows: res } = await customerPool.query(
      `SELECT 1 FROM periodic_report_result
        WHERE customer_id = $1 AND period = 'DAILY'
          AND bucket_date = $2::date AND tz = $3 AND lang = 'KOREAN'`,
      [CUSTOMER_ID, bucket, TZ],
    );
    expect(res).toHaveLength(0);
  });

  it("pickQueuedReportJobs honors a future next_due_at on a queued row", async () => {
    const bucket = "2026-06-11";
    await seedState(authPool, "DAILY", bucket, "ready");
    await authPool.query(
      `INSERT INTO periodic_report_job
         (customer_id, period, bucket_date, tz, lang, model_name, model,
          status, generation, dry_run, next_due_at)
       VALUES ($1, 'DAILY', $2::date, $3, 'ENGLISH', 'openai', 'gpt-4o',
               'queued', 1, FALSE, NOW() + INTERVAL '1 hour')`,
      [CUSTOMER_ID, bucket, TZ],
    );
    const tickOpts = {
      authPool,
      resolveCustomerPool: () => customerPool,
      loadRanges: async () => EMPTY_RANGES,
      callGenerateReport: async () => AIMER_RESPONSE,
    };
    const statusOf = async () =>
      (
        await authPool.query<{ status: string }>(
          `SELECT status FROM periodic_report_job
            WHERE customer_id = $1 AND period = 'DAILY'
              AND bucket_date = $2::date AND tz = $3`,
          [CUSTOMER_ID, bucket, TZ],
        )
      ).rows[0].status;

    // Future next_due_at → the row is NOT picked (DB is shared across tests,
    // so assert on this row's own status, not the global pick count).
    await tickReportJobsOnce(authPool, 50, tickOpts);
    expect(await statusOf()).toBe("queued");

    // Clear next_due_at → the same row is now picked and processed to done.
    await authPool.query(
      `UPDATE periodic_report_job SET next_due_at = NULL
        WHERE customer_id = $1 AND period = 'DAILY'
          AND bucket_date = $2::date AND tz = $3`,
      [CUSTOMER_ID, bucket, TZ],
    );
    await tickReportJobsOnce(authPool, 50, tickOpts);
    expect(await statusOf()).toBe("done");
  });

  it("claim rejects a stale picked row deferred by a concurrent tick", async () => {
    // Pickup and claim are split, so a concurrent tick can hold a stale
    // JobPickup for this row from before another worker deferred it. The
    // non-terminal canonical-defer leaves status='queued' and attempts
    // unchanged while setting a future next_due_at, so a stale claim still
    // satisfies status/generation/attempts. Without the next_due_at gate on
    // the claim UPDATE the stale worker would re-claim the just-deferred row
    // and run immediately — bypassing the defer backoff (#412 review round
    // 2). Here the canonical and both-lang leaves are present, so a
    // SUCCESSFUL claim would generate natively (aimerCalls=1); the fix must
    // keep aimerCalls=0 and leave the row in its deferred state.
    aimerCalls = 0;
    const bucket = "2026-06-16";
    const eventKey = "8101";
    let translateCalls = 0;
    await seedState(authPool, "DAILY", bucket, "ready");
    await seedBaselineEvent(customerPool, eventKey, `${bucket}T01:00:00Z`);
    await seedEventLeafLang(customerPool, eventKey, "ENGLISH", "v1");
    await seedEventLeafLang(customerPool, eventKey, "KOREAN", "v1");
    await seedCanonicalResult(customerPool, "DAILY", bucket, eventKey);
    // Model the row as already deferred by a concurrent tick: queued, a
    // future next_due_at, attempts still 0 (the non-terminal defer never
    // increments attempts).
    await authPool.query(
      `INSERT INTO periodic_report_job
         (customer_id, period, bucket_date, tz, lang, model_name, model,
          status, generation, attempts, dry_run, next_due_at, last_error)
       VALUES ($1, 'DAILY', $2::date, $3, 'KOREAN', 'openai', 'gpt-4o',
               'queued', 1, 0, FALSE, NOW() + INTERVAL '1 hour',
               'english_canonical_not_ready')`,
      [CUSTOMER_ID, bucket, TZ],
    );

    // A stale worker (attempts=0, same generation) tries to process the row.
    await processReportJob(makeJob({ bucket_date: bucket, lang: "KOREAN" }), {
      authPool,
      resolveCustomerPool: () => customerPool,
      loadRanges: async () => EMPTY_RANGES,
      callGenerateReport: async () => {
        aimerCalls += 1;
        return AIMER_RESPONSE;
      },
      callTranslateReport: async () => {
        translateCalls += 1;
        return AIMER_RESPONSE;
      },
    });

    // The claim was rejected: no LLM call of either kind.
    expect(aimerCalls).toBe(0);
    expect(translateCalls).toBe(0);

    // The deferred state is untouched — still queued at the future
    // next_due_at, attempts unchanged, never stamped processing.
    const { rows } = await authPool.query<{
      status: string;
      attempts: number;
      future: boolean;
      processing_started_at: string | null;
    }>(
      `SELECT status, attempts,
              (next_due_at IS NOT NULL AND next_due_at > NOW()) AS future,
              processing_started_at::text AS processing_started_at
         FROM periodic_report_job
        WHERE customer_id = $1 AND period = 'DAILY'
          AND bucket_date = $2::date AND tz = $3 AND lang = 'KOREAN'`,
      [CUSTOMER_ID, bucket, TZ],
    );
    expect(rows[0].status).toBe("queued");
    expect(rows[0].attempts).toBe(0);
    expect(rows[0].future).toBe(true);
    expect(rows[0].processing_started_at).toBeNull();

    // No Korean result row was written.
    const { rows: res } = await customerPool.query(
      `SELECT 1 FROM periodic_report_result
        WHERE customer_id = $1 AND period = 'DAILY'
          AND bucket_date = $2::date AND tz = $3 AND lang = 'KOREAN'`,
      [CUSTOMER_ID, bucket, TZ],
    );
    expect(res).toHaveLength(0);
  });

  it("translates from the canonical when a cited leaf is missing in the target lang", async () => {
    aimerCalls = 0;
    const bucket = "2026-06-12";
    const eventKey = "5001";
    let translateCalls = 0;
    let translateLang: string | null = null;
    const TRANSLATED = {
      sections: JSON.stringify({
        ...AIMER_SECTIONS,
        // Same citation-unit shape as the canonical (one uncited unit) so the
        // translate-path structure-parity guard accepts it (#449 round 1).
        executive_summary: [{ text: "조용한 기간." }],
      }),
      promptVersion: "translate-pv-1",
      modelActualVersion: "gpt-4o-translate",
    };
    await seedState(authPool, "DAILY", bucket, "ready");
    await seedBaselineEvent(customerPool, eventKey, `${bucket}T01:00:00Z`);
    // English leaf exists (canonical refs resolve), but NO Korean leaf.
    await seedEventLeafLang(customerPool, eventKey, "ENGLISH", "v1");
    await seedCanonicalResult(customerPool, "DAILY", bucket, eventKey);
    await seedQueuedJobLang(authPool, "DAILY", bucket, "KOREAN");

    await processReportJob(makeJob({ bucket_date: bucket, lang: "KOREAN" }), {
      authPool,
      resolveCustomerPool: () => customerPool,
      loadRanges: async () => EMPTY_RANGES,
      callGenerateReport: async () => {
        aimerCalls += 1;
        return AIMER_RESPONSE;
      },
      callTranslateReport: async (a) => {
        translateCalls += 1;
        translateLang = a.targetLang;
        return TRANSLATED;
      },
    });

    expect(aimerCalls).toBe(0);
    expect(translateCalls).toBe(1);
    expect(translateLang).toBe("KOREAN");

    // The translated row copies the canonical's audit metadata + refs and
    // pins restoration_lang = ENGLISH.
    const { rows } = await customerPool.query<{
      restoration_lang: string | null;
      model_actual_version: string;
      prompt_version: string;
      input_event_refs: Array<{ aice_id: string; event_key: string }>;
    }>(
      `SELECT restoration_lang, model_actual_version, prompt_version,
              input_event_refs
         FROM periodic_report_result
        WHERE customer_id = $1 AND period = 'DAILY'
          AND bucket_date = $2::date AND tz = $3 AND lang = 'KOREAN'`,
      [CUSTOMER_ID, bucket, TZ],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].restoration_lang).toBe("ENGLISH");
    expect(rows[0].model_actual_version).toBe("canon-mv");
    expect(rows[0].prompt_version).toBe("canon-pv");
    expect(rows[0].input_event_refs[0].aice_id).toBe("aice-1");

    // The job is done and carries the translation audit columns.
    const { rows: job } = await authPool.query<{
      status: string;
      translation_model_name: string | null;
      translation_model: string | null;
      translation_prompt_version: string | null;
    }>(
      `SELECT status, translation_model_name, translation_model,
              translation_prompt_version
         FROM periodic_report_job
        WHERE customer_id = $1 AND period = 'DAILY'
          AND bucket_date = $2::date AND tz = $3 AND lang = 'KOREAN'`,
      [CUSTOMER_ID, bucket, TZ],
    );
    expect(job[0].status).toBe("done");
    expect(job[0].translation_model_name).toBe("openai");
    expect(job[0].translation_model).toBe("gpt-4o");
    expect(job[0].translation_prompt_version).toBe("translate-pv-1");
  });

  it("fails the translate path on a fabricated citation source, no translated row (#449)", async () => {
    // The translate path re-emits each unit's `source`, so the citation-source
    // guard must run here too (#449 AC: both worker paths). A translator that
    // rewrote a citation to a leaf absent from the canonical's input bundle
    // must fail the job before the customer-DB write — never orphaning a
    // citation in a persisted translated row.
    aimerCalls = 0;
    const bucket = "2026-07-14";
    const eventKey = "5101";
    let translateCalls = 0;
    // The canonical (seedCanonicalResult) cites only event `aice-1:5101` and no
    // stories, so a `story` source is fabricated by construction.
    const TRANSLATED = {
      sections: JSON.stringify({
        ...AIMER_SECTIONS,
        executive_summary: [
          {
            text: "번역 중 만들어진 출처.",
            source: { type: "story", story_id: "ghost-story" },
          },
        ],
      }),
      promptVersion: "translate-pv-1",
      modelActualVersion: "gpt-4o-translate",
    };
    await seedState(authPool, "DAILY", bucket, "ready");
    await seedBaselineEvent(customerPool, eventKey, `${bucket}T01:00:00Z`);
    // English leaf exists (canonical refs resolve), but NO Korean leaf — so the
    // worker takes the translate path rather than generating natively.
    await seedEventLeafLang(customerPool, eventKey, "ENGLISH", "v1");
    await seedCanonicalResult(customerPool, "DAILY", bucket, eventKey);
    await seedQueuedJobLang(authPool, "DAILY", bucket, "KOREAN");

    await processReportJob(makeJob({ bucket_date: bucket, lang: "KOREAN" }), {
      authPool,
      resolveCustomerPool: () => customerPool,
      loadRanges: async () => EMPTY_RANGES,
      callGenerateReport: async () => {
        aimerCalls += 1;
        return AIMER_RESPONSE;
      },
      callTranslateReport: async () => {
        translateCalls += 1;
        return TRANSLATED;
      },
    });

    // The translate call happened, but its fabricated citation is rejected.
    expect(aimerCalls).toBe(0);
    expect(translateCalls).toBe(1);
    const { rows: job } = await authPool.query<{
      status: string;
      last_error: string | null;
    }>(
      `SELECT status, last_error FROM periodic_report_job
        WHERE customer_id = $1 AND period = 'DAILY'
          AND bucket_date = $2::date AND tz = $3 AND lang = 'KOREAN'`,
      [CUSTOMER_ID, bucket, TZ],
    );
    expect(job[0].status).toBe("failed");
    expect(job[0].last_error).toBe("citation_source_invalid");
    // No translated row was persisted.
    const { rows: result } = await customerPool.query(
      `SELECT 1 FROM periodic_report_result
        WHERE customer_id = $1 AND period = 'DAILY'
          AND bucket_date = $2::date AND tz = $3 AND lang = 'KOREAN'`,
      [CUSTOMER_ID, bucket, TZ],
    );
    expect(result).toHaveLength(0);
  });

  it("fails the translate path when a leaf-derived section loses its array shape (#449)", async () => {
    // A bad/misconfigured translator that returns a legacy non-array section
    // would silently strip every sentence-level citation from that section
    // while still passing the leaf-validity guard (which skips non-array
    // sections). The wire field is opaque `String!`, so aimer-web must compare
    // the translated structure against the canonical and reject the drift
    // (#449 review round 1).
    aimerCalls = 0;
    const bucket = "2026-07-21";
    const eventKey = "5201";
    let translateCalls = 0;
    const TRANSLATED = {
      sections: JSON.stringify({
        ...AIMER_SECTIONS,
        // Canonical `executive_summary` is a citation-unit array; this legacy
        // scalar drops the per-unit structure a citation anchors to.
        executive_summary: "조용한 기간.",
      }),
      promptVersion: "translate-pv-1",
      modelActualVersion: "gpt-4o-translate",
    };
    await seedState(authPool, "DAILY", bucket, "ready");
    await seedBaselineEvent(customerPool, eventKey, `${bucket}T01:00:00Z`);
    await seedEventLeafLang(customerPool, eventKey, "ENGLISH", "v1");
    await seedCanonicalResult(customerPool, "DAILY", bucket, eventKey);
    await seedQueuedJobLang(authPool, "DAILY", bucket, "KOREAN");

    await processReportJob(makeJob({ bucket_date: bucket, lang: "KOREAN" }), {
      authPool,
      resolveCustomerPool: () => customerPool,
      loadRanges: async () => EMPTY_RANGES,
      callGenerateReport: async () => {
        aimerCalls += 1;
        return AIMER_RESPONSE;
      },
      callTranslateReport: async () => {
        translateCalls += 1;
        return TRANSLATED;
      },
    });

    expect(aimerCalls).toBe(0);
    expect(translateCalls).toBe(1);
    const { rows: job } = await authPool.query<{
      status: string;
      last_error: string | null;
    }>(
      `SELECT status, last_error FROM periodic_report_job
        WHERE customer_id = $1 AND period = 'DAILY'
          AND bucket_date = $2::date AND tz = $3 AND lang = 'KOREAN'`,
      [CUSTOMER_ID, bucket, TZ],
    );
    expect(job[0].status).toBe("failed");
    expect(job[0].last_error).toBe("citation_structure_mismatch");
    const { rows: result } = await customerPool.query(
      `SELECT 1 FROM periodic_report_result
        WHERE customer_id = $1 AND period = 'DAILY'
          AND bucket_date = $2::date AND tz = $3 AND lang = 'KOREAN'`,
      [CUSTOMER_ID, bucket, TZ],
    );
    expect(result).toHaveLength(0);
  });

  it("fails the translate path when translation drops a unit's citation source (#449)", async () => {
    // The translator preserved the unit array shape and count but dropped the
    // `source` from a unit the canonical had cited — turning a grounded
    // sentence into an unattributed one. The leaf-validity guard cannot catch
    // this (a missing `source` reads as a deliberately-uncited unit), so the
    // structure-parity check against the canonical is the only line of defense
    // (#449 review round 1).
    aimerCalls = 0;
    const bucket = "2026-07-28";
    const eventKey = "5202";
    let translateCalls = 0;
    await seedState(authPool, "DAILY", bucket, "ready");
    await seedBaselineEvent(customerPool, eventKey, `${bucket}T01:00:00Z`);
    await seedEventLeafLang(customerPool, eventKey, "ENGLISH", "v1");
    await seedCanonicalResult(customerPool, "DAILY", bucket, eventKey);
    // Make the canonical CITE the in-bundle event in its executive summary so
    // there is a real citation for the translation to drop.
    await customerPool.query(
      `UPDATE periodic_report_result
          SET sections_jsonb = $4::jsonb
        WHERE customer_id = $1 AND period = 'DAILY'
          AND bucket_date = $2::date AND tz = $3 AND lang = 'ENGLISH'`,
      [
        CUSTOMER_ID,
        bucket,
        TZ,
        JSON.stringify({
          ...AIMER_SECTIONS,
          executive_summary: [
            {
              text: "A grounded claim.",
              source: { type: "event", event_ref: `aice-1:${eventKey}` },
            },
          ],
        }),
      ],
    );
    await seedQueuedJobLang(authPool, "DAILY", bucket, "KOREAN");

    const TRANSLATED = {
      sections: JSON.stringify({
        ...AIMER_SECTIONS,
        // Same unit count, but the citation `source` was dropped.
        executive_summary: [{ text: "근거 있는 주장." }],
      }),
      promptVersion: "translate-pv-1",
      modelActualVersion: "gpt-4o-translate",
    };

    await processReportJob(makeJob({ bucket_date: bucket, lang: "KOREAN" }), {
      authPool,
      resolveCustomerPool: () => customerPool,
      loadRanges: async () => EMPTY_RANGES,
      callGenerateReport: async () => {
        aimerCalls += 1;
        return AIMER_RESPONSE;
      },
      callTranslateReport: async () => {
        translateCalls += 1;
        return TRANSLATED;
      },
    });

    expect(aimerCalls).toBe(0);
    expect(translateCalls).toBe(1);
    const { rows: job } = await authPool.query<{
      status: string;
      last_error: string | null;
    }>(
      `SELECT status, last_error FROM periodic_report_job
        WHERE customer_id = $1 AND period = 'DAILY'
          AND bucket_date = $2::date AND tz = $3 AND lang = 'KOREAN'`,
      [CUSTOMER_ID, bucket, TZ],
    );
    expect(job[0].status).toBe("failed");
    expect(job[0].last_error).toBe("citation_structure_mismatch");
    const { rows: result } = await customerPool.query(
      `SELECT 1 FROM periodic_report_result
        WHERE customer_id = $1 AND period = 'DAILY'
          AND bucket_date = $2::date AND tz = $3 AND lang = 'KOREAN'`,
      [CUSTOMER_ID, bucket, TZ],
    );
    expect(result).toHaveLength(0);
  });

  it("aborts the translate write when the watchdog requeues mid-call (audit not lost)", async () => {
    // A slow translate attempt overruns the watchdog timeout:
    // `recoverStuckReportJobs` returns the row to `queued` and clears
    // `processing_started_at` while the attempt still holds the advisory
    // lock. When the late attempt resumes, the claim-marker-guarded
    // `recordTranslationAudit` matches ZERO rows. It must ABORT before the
    // customer-DB insert — otherwise it would write a durable translated
    // result row whose audit columns never landed, and the next retry's
    // result probe would `preserve` them as NULL, re-introducing the
    // audit-loss class via the watchdog/late-return path (#412 item 6 /
    // round 5).
    aimerCalls = 0;
    const bucket = "2026-06-18";
    const eventKey = "5004";
    let translateCalls = 0;
    const TRANSLATED = {
      sections: JSON.stringify({
        ...AIMER_SECTIONS,
        // Same citation-unit shape as the canonical (one uncited unit) so the
        // translate-path structure-parity guard accepts it (#449 round 1).
        executive_summary: [{ text: "조용한 기간." }],
      }),
      promptVersion: "translate-pv-1",
      modelActualVersion: "gpt-4o-translate",
    };
    await seedState(authPool, "DAILY", bucket, "ready");
    await seedBaselineEvent(customerPool, eventKey, `${bucket}T01:00:00Z`);
    await seedEventLeafLang(customerPool, eventKey, "ENGLISH", "v1");
    await seedCanonicalResult(customerPool, "DAILY", bucket, eventKey);
    await seedQueuedJobLang(authPool, "DAILY", bucket, "KOREAN");

    await processReportJob(makeJob({ bucket_date: bucket, lang: "KOREAN" }), {
      authPool,
      resolveCustomerPool: () => customerPool,
      loadRanges: async () => EMPTY_RANGES,
      callGenerateReport: async () => {
        aimerCalls += 1;
        return AIMER_RESPONSE;
      },
      callTranslateReport: async () => {
        translateCalls += 1;
        // Simulate the watchdog timing out this attempt mid-call: return the
        // row to `queued` and clear the claim marker, exactly as
        // `recoverStuckReportJobs` does.
        await authPool.query(
          `UPDATE periodic_report_job
              SET status = 'queued', processing_started_at = NULL,
                  next_due_at = NULL, updated_at = NOW()
            WHERE customer_id = $1 AND period = 'DAILY'
              AND bucket_date = $2::date AND tz = $3 AND lang = 'KOREAN'`,
          [CUSTOMER_ID, bucket, TZ],
        );
        return TRANSLATED;
      },
    });

    expect(aimerCalls).toBe(0);
    expect(translateCalls).toBe(1);

    // No translated result row was written — the attempt aborted at the
    // authoritative pre-write audit check.
    const { rows: result } = await customerPool.query(
      `SELECT 1 FROM periodic_report_result
        WHERE customer_id = $1 AND period = 'DAILY'
          AND bucket_date = $2::date AND tz = $3 AND lang = 'KOREAN'`,
      [CUSTOMER_ID, bucket, TZ],
    );
    expect(result).toHaveLength(0);

    // The job is back in `queued` (left by the watchdog) with NO audit
    // columns persisted — nothing to preserve as NULL on the next retry.
    const { rows: job } = await authPool.query<{
      status: string;
      translation_model_name: string | null;
      translation_model: string | null;
      translation_prompt_version: string | null;
    }>(
      `SELECT status, translation_model_name, translation_model,
              translation_prompt_version
         FROM periodic_report_job
        WHERE customer_id = $1 AND period = 'DAILY'
          AND bucket_date = $2::date AND tz = $3 AND lang = 'KOREAN'`,
      [CUSTOMER_ID, bucket, TZ],
    );
    expect(job[0].status).toBe("queued");
    expect(job[0].translation_model_name).toBeNull();
    expect(job[0].translation_model).toBeNull();
    expect(job[0].translation_prompt_version).toBeNull();
  });

  it("loads a SAME-generation English canonical even after it is superseded", async () => {
    // A non-English job at generation N must still derive from the
    // generation-N English canonical even once that row has been superseded by
    // a LATER English-only generation. Reachable without an operator: the LIVE
    // cadence bump only advances `done` variants, so a still-deferred Korean
    // gen-1 job stays at gen 1 while English advances to gen 2 and supersedes
    // the gen-1 English row. The lookup pins `generation = job.generation`
    // (unique by PK), so dropping the stale `superseded_at IS NULL` predicate
    // lets the gen-1 job translate instead of deferring forever (#412 round 4).
    aimerCalls = 0;
    const bucket = "2026-06-24";
    const eventKey = "9001";
    let translateCalls = 0;
    const TRANSLATED = {
      sections: JSON.stringify({
        ...AIMER_SECTIONS,
        // Same citation-unit shape as the canonical (one uncited unit) so the
        // translate-path structure-parity guard accepts it (#449 round 1).
        executive_summary: [{ text: "조용한 기간." }],
      }),
      promptVersion: "translate-pv-1",
      modelActualVersion: "gpt-4o-translate",
    };
    await seedState(authPool, "DAILY", bucket, "ready");
    await seedBaselineEvent(customerPool, eventKey, `${bucket}T01:00:00Z`);
    // English leaf exists (canonical refs resolve), but NO Korean leaf → the
    // completeness gate misses and the job routes to translation.
    await seedEventLeafLang(customerPool, eventKey, "ENGLISH", "v1");
    await seedCanonicalResult(customerPool, "DAILY", bucket, eventKey);
    // English advanced to gen 2, superseding the gen-1 canonical the Korean
    // gen-1 job still depends on.
    await customerPool.query(
      `UPDATE periodic_report_result SET superseded_at = NOW()
        WHERE customer_id = $1 AND period = 'DAILY'
          AND bucket_date = $2::date AND tz = $3 AND lang = 'ENGLISH'
          AND generation = 1`,
      [CUSTOMER_ID, bucket, TZ],
    );
    await seedQueuedJobLang(authPool, "DAILY", bucket, "KOREAN");

    await processReportJob(makeJob({ bucket_date: bucket, lang: "KOREAN" }), {
      authPool,
      resolveCustomerPool: () => customerPool,
      loadRanges: async () => EMPTY_RANGES,
      callGenerateReport: async () => {
        aimerCalls += 1;
        return AIMER_RESPONSE;
      },
      callTranslateReport: async () => {
        translateCalls += 1;
        return TRANSLATED;
      },
    });

    // Translated off the superseded same-generation canonical — NOT deferred.
    expect(aimerCalls).toBe(0);
    expect(translateCalls).toBe(1);

    const { rows: job } = await authPool.query<{
      status: string;
      last_error: string | null;
    }>(
      `SELECT status, last_error FROM periodic_report_job
        WHERE customer_id = $1 AND period = 'DAILY'
          AND bucket_date = $2::date AND tz = $3 AND lang = 'KOREAN'`,
      [CUSTOMER_ID, bucket, TZ],
    );
    expect(job[0].status).toBe("done");
    expect(job[0].last_error).not.toBe("english_canonical_not_ready");

    const { rows } = await customerPool.query<{
      restoration_lang: string | null;
    }>(
      `SELECT restoration_lang FROM periodic_report_result
        WHERE customer_id = $1 AND period = 'DAILY'
          AND bucket_date = $2::date AND tz = $3 AND lang = 'KOREAN'`,
      [CUSTOMER_ID, bucket, TZ],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].restoration_lang).toBe("ENGLISH");
  });

  it("generates natively when every cited leaf exists in the target lang", async () => {
    aimerCalls = 0;
    const bucket = "2026-06-13";
    const eventKey = "6001";
    let translateCalls = 0;
    await seedState(authPool, "DAILY", bucket, "ready");
    await seedBaselineEvent(customerPool, eventKey, `${bucket}T01:00:00Z`);
    await seedEventLeafLang(customerPool, eventKey, "ENGLISH", "v1");
    // Korean leaf present at the SAME pinned (event_key, generation) → the
    // completeness gate passes, so the worker generates natively.
    await seedEventLeafLang(customerPool, eventKey, "KOREAN", "v1");
    await seedCanonicalResult(customerPool, "DAILY", bucket, eventKey);
    await seedQueuedJobLang(authPool, "DAILY", bucket, "KOREAN");

    await processReportJob(makeJob({ bucket_date: bucket, lang: "KOREAN" }), {
      authPool,
      resolveCustomerPool: () => customerPool,
      loadRanges: async () => EMPTY_RANGES,
      callGenerateReport: async () => {
        aimerCalls += 1;
        return AIMER_RESPONSE;
      },
      callTranslateReport: async () => {
        translateCalls += 1;
        return AIMER_RESPONSE;
      },
    });

    // Native generation, NOT translation.
    expect(aimerCalls).toBe(1);
    expect(translateCalls).toBe(0);

    // A natively-generated row has no restoration_lang pin.
    const { rows } = await customerPool.query<{
      restoration_lang: string | null;
    }>(
      `SELECT restoration_lang FROM periodic_report_result
        WHERE customer_id = $1 AND period = 'DAILY'
          AND bucket_date = $2::date AND tz = $3 AND lang = 'KOREAN'`,
      [CUSTOMER_ID, bucket, TZ],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].restoration_lang).toBeNull();
  });

  it("translates (not native) when only another customer has the target-lang story leaf", async () => {
    aimerCalls = 0;
    const bucket = "2026-06-23";
    const storyId = "7001";
    let translateCalls = 0;
    const TRANSLATED = {
      sections: JSON.stringify({
        ...AIMER_SECTIONS,
        // Same citation-unit shape as the canonical (one uncited unit) so the
        // translate-path structure-parity guard accepts it (#449 round 1).
        executive_summary: [{ text: "조용한 기간." }],
      }),
      promptVersion: "translate-pv-1",
      modelActualVersion: "gpt-4o-translate",
    };
    await seedState(authPool, "DAILY", bucket, "ready");
    // A canonical story leaf for THIS customer (English) + the story row.
    await customerPool.query(
      `INSERT INTO story
         (story_id, story_version, kind, time_window_start, time_window_end,
          summary_payload, source_aice_id, received_at)
       VALUES ($1::bigint, 'sv1', 'auto_correlated',
               ($2::date)::timestamptz, ($2::date)::timestamptz + INTERVAL '1 day',
               '{}'::jsonb, 'aice-1', ($2::date)::timestamptz)`,
      [storyId, bucket],
    );
    await seedStoryLeafLang(customerPool, CUSTOMER_ID, storyId, "ENGLISH");
    // The Korean story leaf exists ONLY for a DIFFERENT customer at the same
    // (story_id, generation, model). Without the customer_id scope the pinned
    // lookup would match it and generate natively off another customer's row.
    await seedStoryLeafLang(customerPool, OTHER_CUSTOMER_ID, storyId, "KOREAN");
    await seedCanonicalResultWithStory(customerPool, "DAILY", bucket, storyId);
    await seedQueuedJobLang(authPool, "DAILY", bucket, "KOREAN");

    await processReportJob(makeJob({ bucket_date: bucket, lang: "KOREAN" }), {
      authPool,
      resolveCustomerPool: () => customerPool,
      loadRanges: async () => EMPTY_RANGES,
      callGenerateReport: async () => {
        aimerCalls += 1;
        return AIMER_RESPONSE;
      },
      callTranslateReport: async () => {
        translateCalls += 1;
        return TRANSLATED;
      },
    });

    // The completeness gate must MISS (no Korean leaf for THIS customer) and
    // route to translation, never native generation off the other customer.
    expect(aimerCalls).toBe(0);
    expect(translateCalls).toBe(1);

    const { rows } = await customerPool.query<{
      restoration_lang: string | null;
    }>(
      `SELECT restoration_lang FROM periodic_report_result
        WHERE customer_id = $1 AND period = 'DAILY'
          AND bucket_date = $2::date AND tz = $3 AND lang = 'KOREAN'`,
      [CUSTOMER_ID, bucket, TZ],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].restoration_lang).toBe("ENGLISH");
  });

  it("dirty auto-requeue clears a stale future next_due_at", async () => {
    const bucket = "2026-06-14";
    await seedState(authPool, "DAILY", bucket, "dirty");
    await authPool.query(
      `INSERT INTO periodic_report_job
         (customer_id, period, bucket_date, tz, lang, model_name, model,
          status, generation, dry_run, last_generated_at, next_due_at)
       VALUES ($1, 'DAILY', $2::date, $3, 'ENGLISH', 'openai', 'gpt-4o',
               'done', 2, FALSE,
               NOW() - INTERVAL '2 hours', NOW() + INTERVAL '1 hour')`,
      [CUSTOMER_ID, bucket, TZ],
    );

    const now = new Date().toISOString();
    const client = await authPool.connect();
    try {
      await seedRealReportJobs(client, 10, now);
    } finally {
      client.release();
    }

    // The bumped row is queued at the next generation with next_due_at
    // cleared, so the picker (which now honors next_due_at) processes it
    // promptly rather than waiting out the stale cadence value.
    const { rows } = await authPool.query<{
      status: string;
      generation: number;
      next_due_at: Date | null;
    }>(
      `SELECT status, generation, next_due_at FROM periodic_report_job
        WHERE customer_id = $1 AND period = 'DAILY'
          AND bucket_date = $2::date AND tz = $3 AND lang = 'ENGLISH'`,
      [CUSTOMER_ID, bucket, TZ],
    );
    expect(rows[0].status).toBe("queued");
    expect(rows[0].generation).toBe(3);
    expect(rows[0].next_due_at).toBeNull();
  });
});
