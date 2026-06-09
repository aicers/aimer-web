// RFC 0004 B3 step 2 (#524) — group multi-member generation worker DB tests.
//
// Covers the issue gates:
//   - group reports union member analyzed leaves; result stored results-only
//     in the group DB; report COUNT matches a single customer (one per bucket)
//   - each persisted provenance ref carries its member `customer_id`
//   - citation keys are member-qualified for the group path (aimerInputs
//     source keys carry `customer_id:...`)
//   - top-K `R{j}` numbering is deterministic across the member union
//     (tie-break includes `customer_id`)
//   - story-covered event exclusion is member-local (a member-A story does not
//     suppress a member-B event)
//   - the operational gate defers non-terminally for a suspended member and
//     resumes on recovery
//   - a missing subject takes the terminal `source_unavailable` release
//   - group default-model resolution is global/env-only at seeding

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
import type { PeriodicReportInputs } from "@/lib/graphql/__generated__/generate-periodic-security-report";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/audit", () => ({ auditLog: vi.fn(async () => {}) }));

process.env.DEFAULT_LOCALE = "en";

const { processReportJob, seedRealReportJobs } = await import(
  "../report-worker"
);

const AUTH_MIGRATIONS_DIR = join(process.cwd(), "migrations", "auth");
const CUSTOMER_MIGRATIONS_DIR = join(process.cwd(), "migrations", "customer");
const GROUP_MIGRATIONS_DIR = join(process.cwd(), "migrations", "group");

const TZ = "Asia/Seoul";
// Member ids chosen so M1 < M2 lexicographically — the union tie-break orders
// by `customer_id`, so the deterministic-order assertions key on this.
const M1 = "00000000-0000-0000-0000-0000000000a1";
const M2 = "00000000-0000-0000-0000-0000000000a2";
const ACCOUNT = "00000000-0000-0000-0000-0000000000b1";
const BUCKET = "2026-05-26";
// 12:00 KST on 2026-05-26 — inside the DAILY bucket window.
const IN_WINDOW = "2026-05-26T03:00:00Z";

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

const EMPTY_RANGES = { v4: [], v6: [] } as unknown as Awaited<
  ReturnType<typeof import("@/lib/redaction/load-ranges").loadCustomerRanges>
>;

function makeGroupJob(
  groupId: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    subject_id: groupId,
    period: "DAILY" as const,
    bucket_date: BUCKET,
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

async function seedEvent(
  pool: Pool,
  aiceId: string,
  eventKey: string,
  opts: { sev?: number; lik?: number; tier?: string } = {},
): Promise<void> {
  const sev = opts.sev ?? 0.6;
  const lik = opts.lik ?? 0.6;
  const tier = opts.tier ?? "MEDIUM";
  await pool.query(
    `INSERT INTO baseline_event
       (baseline_version, event_key, event_time, kind, category, raw_score,
        raw_event, score_window_context, window_signals,
        scoring_weights_snapshot, source_aice_id, received_at)
     VALUES ('vA', $1::numeric, $2::timestamptz, 'k', 'recon', 0.5,
             '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, $3, $2::timestamptz)`,
    [eventKey, IN_WINDOW, aiceId],
  );
  await pool.query(
    `INSERT INTO event_analysis_result
       (aice_id, event_key, lang, model_name, model,
        model_actual_version, prompt_version, generation,
        severity_score, likelihood_score,
        severity_factors, likelihood_factors, ttp_tags,
        priority_tier, analysis_text, redaction_policy_version, requested_by)
     VALUES ($1, $2::numeric, 'ENGLISH', 'openai', 'gpt-4o',
             'mv', 'pv', 1, $3, $4,
             '[]'::jsonb, '[]'::jsonb, '["T1110"]'::jsonb,
             $5, 'event leaf', 'v1', gen_random_uuid())`,
    [aiceId, eventKey, sev, lik, tier],
  );
}

async function seedStory(
  authPool: Pool,
  pool: Pool,
  memberId: string,
  storyId: string,
  sourceAiceId: string,
  memberEventKey: string,
): Promise<void> {
  await pool.query(
    `INSERT INTO story
       (story_id, story_version, kind, primary_asset,
        time_window_start, time_window_end, summary_payload,
        source_aice_id, received_at)
     VALUES ($1::bigint, 'v1', 'auto_correlated', 'host-1',
             $2::timestamptz, $3::timestamptz, '{}'::jsonb, $4, $2::timestamptz)`,
    [storyId, IN_WINDOW, "2026-05-26T04:00:00Z", sourceAiceId],
  );
  await pool.query(
    `INSERT INTO story_member
       (story_id, story_version, member_event_key, role, event)
     VALUES ($1::bigint, 'v1', $2::numeric, 'primary', '{}'::jsonb)`,
    [storyId, memberEventKey],
  );
  await pool.query(
    `INSERT INTO story_analysis_result
       (customer_id, story_id, lang, model_name, model,
        model_actual_version, prompt_version, generation,
        severity_score, likelihood_score,
        severity_factors, likelihood_factors, ttp_tags,
        priority_tier, analysis_text, input_event_refs, input_fact_refs,
        input_hash, redaction_policy_version)
     VALUES ($1, $2::bigint, 'ENGLISH', 'openai', 'gpt-4o',
             'mv', 'pv', 1, 0.8, 0.7,
             '[]'::jsonb, '[]'::jsonb, '["T1078"]'::jsonb,
             'HIGH', 'story leaf', '[]'::jsonb, '[]'::jsonb, 'h', 'v1')`,
    [memberId, storyId],
  );
  await authPool.query(
    `INSERT INTO story_analysis_state (customer_id, story_id, status)
     VALUES ($1, $2::bigint, 'ready')
     ON CONFLICT (customer_id, story_id) DO UPDATE SET status = 'ready'`,
    [memberId, storyId],
  );
}

async function seedGroupStateJob(
  authPool: Pool,
  groupId: string,
): Promise<void> {
  await authPool.query(
    `INSERT INTO periodic_report_state (subject_id, period, bucket_date, tz, status)
     VALUES ($1, 'DAILY', $2::date, $3, 'ready')
     ON CONFLICT (subject_id, period, bucket_date, tz)
       DO UPDATE SET status = 'ready'`,
    [groupId, BUCKET, TZ],
  );
  await authPool.query(
    `INSERT INTO periodic_report_job
       (subject_id, period, bucket_date, tz, lang, model_name, model,
        status, generation, dry_run)
     VALUES ($1, 'DAILY', $2::date, $3, 'ENGLISH', 'openai', 'gpt-4o',
             'queued', 1, FALSE)
     ON CONFLICT (subject_id, period, bucket_date, tz, lang, model_name, model)
       DO UPDATE SET status = 'queued', generation = 1, attempts = 0,
                     next_due_at = NULL, last_error = NULL`,
    [groupId, BUCKET, TZ],
  );
}

describe.skipIf(!hasPostgres)("group report worker (#524)", () => {
  let authDbName: string;
  let authPool: Pool;
  let custADbName: string;
  let custAPool: Pool;
  let custBDbName: string;
  let custBPool: Pool;
  let groupDbName: string;
  let groupPool: Pool;
  let groupId: string;
  let aimerCalls: number;
  let capturedInputs: PeriodicReportInputs | null;

  const subjectPoolsOverride = async () => ({
    kind: "group" as const,
    resultPool: groupPool,
    memberPools: [
      { customerId: M1, pool: custAPool },
      { customerId: M2, pool: custBPool },
    ],
  });

  const opts = (over: Record<string, unknown> = {}) =>
    ({
      authPool,
      resolveSubjectPools: subjectPoolsOverride,
      loadRanges: async () => EMPTY_RANGES,
      callGenerateReport: async (args: { inputs: PeriodicReportInputs }) => {
        aimerCalls += 1;
        capturedInputs = args.inputs;
        return AIMER_RESPONSE;
      },
      ...over,
      // biome-ignore lint/suspicious/noExplicitAny: test opts shape
    }) as any;

  beforeAll(async () => {
    const auth = await createTestDatabase("group_worker_auth");
    authDbName = auth.dbName;
    authPool = auth.pool;
    await runMigrations(authPool, AUTH_MIGRATIONS_DIR, 5401);

    const a = await createTestDatabase("group_worker_m1");
    custADbName = a.dbName;
    custAPool = a.pool;
    await runMigrations(custAPool, CUSTOMER_MIGRATIONS_DIR, 5402);

    const b = await createTestDatabase("group_worker_m2");
    custBDbName = b.dbName;
    custBPool = b.pool;
    await runMigrations(custBPool, CUSTOMER_MIGRATIONS_DIR, 5403);

    const g = await createTestDatabase("group_worker_grp");
    groupDbName = g.dbName;
    groupPool = g.pool;
    await runMigrations(groupPool, GROUP_MIGRATIONS_DIR, 5404);

    await authPool.query(
      `INSERT INTO accounts (id, oidc_issuer, oidc_subject, username, display_name)
       VALUES ($1, 'iss', 'sub', 'u', 'U')`,
      [ACCOUNT],
    );
    for (const [id, key] of [
      [M1, "m1"],
      [M2, "m2"],
    ]) {
      await authPool.query(
        `INSERT INTO customers (id, external_key, name, database_status, timezone)
         VALUES ($1, $2, $2, 'active', $3)`,
        [id, key, TZ],
      );
    }
    // Create the group subject + entity, then mark its data DB active.
    const subj = await authPool.query<{ id: string }>(
      `INSERT INTO subjects (kind) VALUES ('group') RETURNING id`,
    );
    groupId = subj.rows[0].id;
    await authPool.query(
      `INSERT INTO customer_groups
         (id, kind, name, created_by, owner_id, tz, database_status)
       VALUES ($1, 'group', 'G', $2, $2, $3, 'active')`,
      [groupId, ACCOUNT, TZ],
    );
    await authPool.query(
      `INSERT INTO customer_group_members (group_id, customer_id)
       VALUES ($1, $2), ($1, $3)`,
      [groupId, M1, M2],
    );
  }, 60_000);

  afterAll(async () => {
    await dropTestDatabase(authDbName, authPool);
    await dropTestDatabase(custADbName, custAPool);
    await dropTestDatabase(custBDbName, custBPool);
    await dropTestDatabase(groupDbName, groupPool);
    await closeAdminPool();
  }, 30_000);

  async function resetData(): Promise<void> {
    aimerCalls = 0;
    capturedInputs = null;
    for (const p of [custAPool, custBPool]) {
      await p.query("DELETE FROM event_analysis_result");
      await p.query("DELETE FROM story_member");
      await p.query("DELETE FROM story_analysis_result");
      await p.query("DELETE FROM baseline_event");
      await p.query("DELETE FROM story");
    }
    await groupPool.query("DELETE FROM periodic_report_result");
    await authPool.query("DELETE FROM periodic_report_job");
    await authPool.query("DELETE FROM periodic_report_state");
    await authPool.query("DELETE FROM story_analysis_state");
    await authPool.query(
      `UPDATE customers SET status = 'active', database_status = 'active'`,
    );
    await authPool.query(
      `UPDATE customer_groups SET database_status = 'active' WHERE id = $1`,
      [groupId],
    );
  }

  it("unions member leaves into one group result with member-qualified refs", async () => {
    await resetData();
    await seedEvent(custAPool, "aice-A", "1", { tier: "HIGH" });
    await seedEvent(custBPool, "aice-B", "2", { tier: "HIGH" });
    await seedGroupStateJob(authPool, groupId);

    await processReportJob(makeGroupJob(groupId), opts());

    expect(aimerCalls).toBe(1);
    // Exactly ONE result row in the GROUP DB (count parity with a customer).
    const { rows } = await groupPool.query<{
      input_event_refs: Array<{ aice_id: string; customer_id: string }>;
      input_story_refs: unknown[];
    }>(
      `SELECT input_event_refs, input_story_refs
         FROM periodic_report_result
        WHERE subject_id = $1 AND period = 'DAILY'
          AND bucket_date = $2::date AND tz = $3 AND generation = 1`,
      [groupId, BUCKET, TZ],
    );
    expect(rows).toHaveLength(1);
    const eventRefs = rows[0].input_event_refs;
    expect(eventRefs).toHaveLength(2);
    // Each ref carries its member customer_id (#523/#524).
    const byMember = new Map(eventRefs.map((r) => [r.customer_id, r]));
    expect(byMember.get(M1)?.aice_id).toBe("aice-A");
    expect(byMember.get(M2)?.aice_id).toBe("aice-B");
    // No raw member events were written to the group DB.
    const tables = await groupPool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'baseline_event'`,
    );
    expect(tables.rows).toHaveLength(0);

    // aimerInputs source keys are member-qualified (customer_id:aice:event).
    const refs = (capturedInputs?.eventAnalyses ?? []).map((e) => e.eventRef);
    expect(refs).toContain(`${M1}:aice-A:1`);
    expect(refs).toContain(`${M2}:aice-B:2`);
  });

  it("translates a non-English group report from the English canonical via member-pool replay", async () => {
    await resetData();
    await seedEvent(custAPool, "aice-A", "1", { tier: "HIGH" });
    await seedEvent(custBPool, "aice-B", "2", { tier: "HIGH" });
    await seedGroupStateJob(authPool, groupId);

    // 1) Generate the English canonical (the translate source-of-truth).
    await processReportJob(makeGroupJob(groupId), opts());
    expect(aimerCalls).toBe(1);

    // 2) A KOREAN job for the same bucket reuses the canonical and translates
    //    — it reconstructs the union token map across the MEMBER pools
    //    (`buildGroupPinnedTokenRefs`) for the leak scan, never re-running the
    //    cross-member selection in the target language.
    await authPool.query(
      `INSERT INTO periodic_report_job
         (subject_id, period, bucket_date, tz, lang, model_name, model,
          status, generation, dry_run)
       VALUES ($1, 'DAILY', $2::date, $3, 'KOREAN', 'openai', 'gpt-4o',
               'queued', 1, FALSE)`,
      [groupId, BUCKET, TZ],
    );
    let translateCalls = 0;
    await processReportJob(
      makeGroupJob(groupId, { lang: "KOREAN" }),
      opts({
        callTranslateReport: async () => {
          translateCalls += 1;
          return AIMER_RESPONSE;
        },
      }),
    );

    expect(translateCalls).toBe(1);
    // The English native generation is NOT re-run for the translation.
    expect(aimerCalls).toBe(1);
    const { rows } = await groupPool.query<{
      restoration_lang: string | null;
      input_event_refs: Array<{ aice_id: string; customer_id: string }>;
    }>(
      `SELECT restoration_lang, input_event_refs
         FROM periodic_report_result
        WHERE subject_id = $1 AND lang = 'KOREAN' AND generation = 1`,
      [groupId],
    );
    expect(rows).toHaveLength(1);
    // Translated rows pin restoration_lang = ENGLISH (replay the English leaves).
    expect(rows[0].restoration_lang).toBe("ENGLISH");
    // Member-qualified refs are copied verbatim onto the translated row.
    const byMember = new Map(
      rows[0].input_event_refs.map((r) => [r.customer_id, r]),
    );
    expect(byMember.get(M1)?.aice_id).toBe("aice-A");
    expect(byMember.get(M2)?.aice_id).toBe("aice-B");
  });

  it("orders the union deterministically by customer_id on a tier/score tie", async () => {
    await resetData();
    // Both members tie on tier HIGH + identical scores.
    await seedEvent(custAPool, "aice-A", "1", {
      tier: "HIGH",
      sev: 0.9,
      lik: 0.9,
    });
    await seedEvent(custBPool, "aice-B", "1", {
      tier: "HIGH",
      sev: 0.9,
      lik: 0.9,
    });
    await seedGroupStateJob(authPool, groupId);

    await processReportJob(makeGroupJob(groupId), opts());

    const { rows } = await groupPool.query<{
      input_event_refs: Array<{ customer_id: string }>;
    }>(
      `SELECT input_event_refs FROM periodic_report_result
        WHERE subject_id = $1 AND generation = 1`,
      [groupId],
    );
    const order = rows[0].input_event_refs.map((r) => r.customer_id);
    // M1 < M2 lexicographically → M1 first, stable across runs.
    expect(order).toEqual([M1, M2]);
  });

  it("keeps story-covered event exclusion member-local", async () => {
    await resetData();
    // Member A: a story covering (aice-A, 1), plus that very event.
    await seedStory(authPool, custAPool, M1, "100", "aice-A", "1");
    await seedEvent(custAPool, "aice-A", "1", { tier: "HIGH" });
    // Member B: the SAME (aice_id, event_key) as a standalone event.
    await seedEvent(custBPool, "aice-A", "1", { tier: "HIGH" });
    await seedGroupStateJob(authPool, groupId);

    await processReportJob(makeGroupJob(groupId), opts());

    const { rows } = await groupPool.query<{
      input_event_refs: Array<{
        aice_id: string;
        event_key: string;
        customer_id: string;
      }>;
    }>(
      `SELECT input_event_refs FROM periodic_report_result
        WHERE subject_id = $1 AND generation = 1`,
      [groupId],
    );
    const refs = rows[0].input_event_refs;
    // Member B's (aice-A, 1) is NOT suppressed by member A's story.
    expect(
      refs.some((r) => r.customer_id === M2 && r.aice_id === "aice-A"),
    ).toBe(true);
    // Member A's own (aice-A, 1) IS suppressed (covered by its story).
    expect(
      refs.some((r) => r.customer_id === M1 && r.aice_id === "aice-A"),
    ).toBe(false);
  });

  it("defers non-terminally when a member is suspended, resumes on recovery", async () => {
    await resetData();
    await seedEvent(custAPool, "aice-A", "1", { tier: "HIGH" });
    await seedEvent(custBPool, "aice-B", "2", { tier: "HIGH" });
    await seedGroupStateJob(authPool, groupId);
    await authPool.query(
      `UPDATE customers SET status = 'suspended' WHERE id = $1`,
      [M2],
    );

    await processReportJob(makeGroupJob(groupId), opts());

    expect(aimerCalls).toBe(0);
    const deferred = await authPool.query<{
      status: string;
      attempts: number;
      next_due_at: Date | null;
      last_error: string | null;
    }>(
      `SELECT status, attempts, next_due_at, last_error
         FROM periodic_report_job WHERE subject_id = $1`,
      [groupId],
    );
    expect(deferred.rows[0].status).toBe("queued");
    expect(deferred.rows[0].attempts).toBe(0);
    expect(deferred.rows[0].next_due_at).not.toBeNull();
    expect(deferred.rows[0].last_error).toBe("group_not_operational");
    const noResult = await groupPool.query(
      `SELECT 1 FROM periodic_report_result WHERE subject_id = $1`,
      [groupId],
    );
    expect(noResult.rows).toHaveLength(0);

    // Recover the member + clear the defer gate; generation now proceeds.
    await authPool.query(
      `UPDATE customers SET status = 'active' WHERE id = $1`,
      [M2],
    );
    await authPool.query(
      `UPDATE periodic_report_job SET next_due_at = NULL WHERE subject_id = $1`,
      [groupId],
    );
    await processReportJob(makeGroupJob(groupId), opts());
    expect(aimerCalls).toBe(1);
    const after = await groupPool.query(
      `SELECT 1 FROM periodic_report_result WHERE subject_id = $1`,
      [groupId],
    );
    expect(after.rows).toHaveLength(1);
  });

  it("releases a missing subject terminally as source_unavailable", async () => {
    await resetData();
    await seedGroupStateJob(authPool, groupId);

    await processReportJob(
      makeGroupJob(groupId),
      opts({
        resolveSubjectPools: async () => {
          throw new Error(`unknown subject ${groupId}`);
        },
      }),
    );

    const { rows } = await authPool.query<{
      status: string;
      last_error: string | null;
      attempts: number;
    }>(
      `SELECT status, last_error, attempts FROM periodic_report_job
        WHERE subject_id = $1`,
      [groupId],
    );
    expect(rows[0].status).toBe("failed");
    expect(rows[0].last_error).toBe("source_unavailable");
    expect(rows[0].attempts).toBe(0);
  });

  it("seeds a group job at the global/env default model (no per-customer override)", async () => {
    await resetData();
    await authPool.query(
      `INSERT INTO periodic_report_state (subject_id, period, bucket_date, tz, status)
       VALUES ($1, 'DAILY', $2::date, $3, 'ready')`,
      [groupId, BUCKET, TZ],
    );
    const client = await authPool.connect();
    try {
      await seedRealReportJobs(client, 100);
    } finally {
      client.release();
    }
    const { rows } = await authPool.query<{
      model_name: string;
      model: string;
      lang: string;
    }>(
      `SELECT model_name, model, lang FROM periodic_report_job
        WHERE subject_id = $1 ORDER BY lang`,
      [groupId],
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r.model_name).toBe("openai");
      expect(r.model).toBe("gpt-4o");
    }
  });
});
