// DB integration test for the reverse-citation lookup (T2, #396) against a
// real customer database with the 0009 GIN migration applied. Validates
// that the JSONB containment (`@>`) probes match the exact persisted ref
// shapes (`{aice_id,event_key,generation,model_name,model,customer_id}`
// for events, `{story_id,...}` for stories), that superseded reports are
// excluded, that the trail is deduped per bucket and ordered newest-first,
// and that the parent-story reverse probe matches the camelCase
// `story_analysis_result` refs.
//
// The auth preamble (cookie / JWT / session / authorize) is covered by the
// unit test; here those modules are stubbed to allow access so the SQL
// itself is exercised end-to-end through the loader.

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
vi.mock("@/lib/auth/cookies", () => ({
  getAuthCookie: vi.fn(async () => "tok"),
}));
vi.mock("@/lib/auth/jwt", () => ({
  verifyJwtFull: vi.fn(async () => ({ sub: "acc-1", sid: "sess-1" })),
}));
vi.mock("@/lib/auth/session-policy", () => ({
  getSessionPolicy: vi.fn(async () => ({ general: {} })),
}));
vi.mock("@/lib/auth/session-validator", () => ({
  validateSession: vi.fn(async () => ({
    bridgeAiceId: null,
    bridgeCustomerIds: null,
  })),
}));
vi.mock("@/lib/auth/authorization", () => ({
  authorize: vi.fn(async () => ({ authorized: true })),
}));
vi.mock("@/lib/db/client", () => ({
  getAuthPool: () => ({ query: vi.fn() }),
  withTransaction: async (_pool: unknown, fn: (client: unknown) => unknown) =>
    fn({ query: vi.fn() }),
}));

const poolHolder: { pool: Pool | null } = { pool: null };
vi.mock("@/lib/db/customer-runtime-pool", () => ({
  getCustomerRuntimePool: () => poolHolder.pool,
}));

const { loadCitedByReports } = await import("../cited-by-loader");

const CUSTOMER_MIGRATIONS_DIR = join(process.cwd(), "migrations", "customer");
const CUSTOMER_LOCK_ID = 3711;
const CUSTOMER_ID = "00000000-0000-0000-0000-0000000004a1";

// Persisted ref fixtures in the always-populated stored shape: every ref
// carries the cited leaf's own `(model_name, model)` (#465) and the owning
// member `customer_id` (#523). The default-model helpers cover the common
// case; the #465 fallback test below builds its off-model ref inline.
function eventRef(aiceId: string, eventKey: string, generation: number) {
  return {
    aice_id: aiceId,
    event_key: eventKey,
    generation,
    model_name: "openai",
    model: "gpt-4o",
    customer_id: CUSTOMER_ID,
  };
}
function storyRef(storyId: string, generation: number) {
  return {
    story_id: storyId,
    generation,
    model_name: "openai",
    model: "gpt-4o",
    customer_id: CUSTOMER_ID,
  };
}

describe.skipIf(!hasPostgres)("reverse-citation lookup (db)", () => {
  let customerDbName: string;
  let customerPool: Pool;

  async function seedReport(args: {
    period: string;
    bucketDate: string;
    tz?: string;
    lang?: string;
    modelName?: string;
    model?: string;
    generation: number;
    tier: string;
    requestedAt: string;
    eventRefs?: unknown[];
    storyRefs?: unknown[];
    superseded?: boolean;
  }): Promise<void> {
    await customerPool.query(
      `INSERT INTO periodic_report_result
         (subject_id, period, bucket_date, tz, lang, model_name, model,
          model_actual_version, prompt_version, generation,
          aggregate_severity_score, aggregate_likelihood_score,
          aggregate_ttp_tags, priority_tier, sections_jsonb,
          input_event_refs, input_story_refs, input_hash,
          redaction_policy_version, requested_by, requested_at, superseded_at)
       VALUES ($1, $2, $3::date, $4, $5, $12, $13,
               'mv', 'pv', $6,
               0, 0,
               '[]'::jsonb, $7, '{}'::jsonb,
               $8::jsonb, $9::jsonb, 'h',
               'baseline-only', NULL,
               $10::timestamptz,
               CASE WHEN $11::boolean THEN NOW() ELSE NULL END)`,
      [
        CUSTOMER_ID,
        args.period,
        args.bucketDate,
        args.tz ?? "Asia/Seoul",
        args.lang ?? "ENGLISH",
        args.generation,
        args.tier,
        JSON.stringify(args.eventRefs ?? []),
        JSON.stringify(args.storyRefs ?? []),
        args.requestedAt,
        args.superseded ?? false,
        args.modelName ?? "openai",
        args.model ?? "gpt-4o",
      ],
    );
  }

  beforeAll(async () => {
    const cust = await createTestDatabase("cited_by_cust");
    customerDbName = cust.dbName;
    customerPool = cust.pool;
    poolHolder.pool = customerPool;
    await runMigrations(
      customerPool,
      CUSTOMER_MIGRATIONS_DIR,
      CUSTOMER_LOCK_ID,
    );

    // Event aice-9/777 at GENERATION 4 is cited by a DAILY report (en + ko
    // variants of the SAME bucket) and an older WEEKLY report. Reports that
    // must NOT appear when probing generation 4: a superseded DAILY gen, a
    // report that cites a different event, and — critically — a report that
    // cited a DIFFERENT generation (gen 3) of the same event (the
    // generation pin must exclude it; review round 1).
    await seedReport({
      period: "DAILY",
      bucketDate: "2026-05-26",
      lang: "ENGLISH",
      generation: 2,
      tier: "HIGH",
      requestedAt: "2026-05-27T12:00:00Z",
      eventRefs: [eventRef("aice-9", "777", 4)],
    });
    await seedReport({
      period: "DAILY",
      bucketDate: "2026-05-26",
      lang: "KOREAN",
      generation: 1,
      tier: "HIGH",
      requestedAt: "2026-05-27T11:00:00Z",
      eventRefs: [eventRef("aice-9", "777", 4)],
    });
    await seedReport({
      period: "WEEKLY",
      bucketDate: "2026-05-24",
      generation: 1,
      tier: "MEDIUM",
      requestedAt: "2026-05-24T09:00:00Z",
      eventRefs: [eventRef("aice-9", "777", 4)],
    });
    await seedReport({
      period: "DAILY",
      bucketDate: "2026-05-25",
      generation: 1,
      tier: "LOW",
      requestedAt: "2026-05-25T08:00:00Z",
      eventRefs: [eventRef("aice-9", "777", 4)],
      superseded: true,
    });
    await seedReport({
      period: "DAILY",
      bucketDate: "2026-05-23",
      generation: 1,
      tier: "LOW",
      requestedAt: "2026-05-23T08:00:00Z",
      eventRefs: [eventRef("aice-other", "111", 1)],
    });
    // Cites the SAME event id but generation 3 — excluded when probing
    // generation 4, included when probing generation 3.
    await seedReport({
      period: "DAILY",
      bucketDate: "2026-05-22",
      generation: 1,
      tier: "LOW",
      requestedAt: "2026-05-22T08:00:00Z",
      eventRefs: [eventRef("aice-9", "777", 3)],
    });

    // Story 555 at generation 2 is cited by one MONTHLY report. A second
    // report cites generation 5 of the same story and must be excluded when
    // probing generation 2.
    await seedReport({
      period: "MONTHLY",
      bucketDate: "2026-05-01",
      generation: 3,
      tier: "CRITICAL",
      requestedAt: "2026-05-31T00:00:00Z",
      storyRefs: [storyRef("555", 2)],
    });
    await seedReport({
      period: "WEEKLY",
      bucketDate: "2026-05-17",
      generation: 1,
      tier: "LOW",
      requestedAt: "2026-05-17T00:00:00Z",
      storyRefs: [storyRef("555", 5)],
    });

    // #465 model-bearing ref: a DEFAULT (gpt-4o) report that, under the
    // never-drop fallback, cited a gpt-5.5 fallback leaf. The ref carries its
    // OWN model (gpt-5.5), not the report row's. A probe for the gpt-5.5 leaf
    // must match (exact model-bearing containment); a probe for a gpt-4o leaf
    // of the SAME id/generation must NOT (the over-match guard — a model-less
    // @> would wrongly match this).
    await seedReport({
      period: "DAILY",
      bucketDate: "2026-06-01",
      modelName: "openai",
      model: "gpt-4o",
      generation: 1,
      tier: "HIGH",
      requestedAt: "2026-06-01T08:00:00Z",
      eventRefs: [
        {
          aice_id: "aice-cov",
          event_key: "900",
          generation: 1,
          model_name: "openai",
          model: "gpt-5.5",
          customer_id: CUSTOMER_ID,
        },
      ],
    });
  });

  afterAll(async () => {
    if (customerPool) await customerPool.end();
    if (customerDbName) await dropTestDatabase(customerDbName);
    await closeAdminPool();
  });

  it("finds citing reports for an event at the probed generation, deduped per bucket, newest-first", async () => {
    const trail = await loadCitedByReports({
      customerId: CUSTOMER_ID,
      leaf: {
        kind: "event",
        aiceId: "aice-9",
        eventKey: "777",
        generation: 4,
        modelName: "openai",
        model: "gpt-4o",
      },
    });
    // DAILY 2026-05-26 (en/ko collapse to one) then WEEKLY 2026-05-24; the
    // superseded DAILY 2026-05-25, the aice-other report, and the report
    // that cited generation 3 of the same event are all excluded.
    expect(trail.map((r) => `${r.period}:${r.bucketDate}`)).toEqual([
      "DAILY:2026-05-26",
      "WEEKLY:2026-05-24",
    ]);
    // The kept DAILY representative is the most-recent (English gen 2) row.
    expect(trail[0]).toMatchObject({ generation: 2, locale: "en" });
  });

  it("excludes reports that cited a different generation of the same event", async () => {
    // Probing generation 3 surfaces only the report that cited gen 3 — the
    // generation pin keeps the gen-4 citers out (review round 1).
    const trail = await loadCitedByReports({
      customerId: CUSTOMER_ID,
      leaf: {
        kind: "event",
        aiceId: "aice-9",
        eventKey: "777",
        generation: 3,
        modelName: "openai",
        model: "gpt-4o",
      },
    });
    expect(trail.map((r) => `${r.period}:${r.bucketDate}`)).toEqual([
      "DAILY:2026-05-22",
    ]);
  });

  it("finds citing reports for a story via input_story_refs at the probed generation", async () => {
    const trail = await loadCitedByReports({
      customerId: CUSTOMER_ID,
      leaf: {
        kind: "story",
        storyId: "555",
        generation: 2,
        modelName: "openai",
        model: "gpt-4o",
      },
    });
    // Only the MONTHLY report cited story generation 2; the WEEKLY report
    // cited generation 5 and is excluded by the pin.
    expect(trail).toHaveLength(1);
    expect(trail[0]).toMatchObject({
      period: "MONTHLY",
      bucketDate: "2026-05-01",
      generation: 3,
      priorityTier: "CRITICAL",
    });
  });

  it("returns an empty trail for a leaf no report cites", async () => {
    const trail = await loadCitedByReports({
      customerId: CUSTOMER_ID,
      leaf: {
        kind: "story",
        storyId: "999",
        generation: 1,
        modelName: "openai",
        model: "gpt-4o",
      },
    });
    expect(trail).toEqual([]);
  });

  it("matches the camelCase story member refs for the event→story backlink", async () => {
    // The event loader's parent-story backlink probes
    // `story_analysis_result.input_event_refs @> [{aiceId, eventKey}]`,
    // whose persisted refs use camelCase keys (unlike the report refs).
    // Verify the containment matches the stored shape end-to-end.
    await customerPool.query(
      `INSERT INTO story_analysis_result
         (customer_id, story_id, lang, model_name, model,
          model_actual_version, prompt_version, generation,
          severity_score, likelihood_score, priority_tier, analysis_text,
          input_event_refs, input_fact_refs, input_hash,
          redaction_policy_version, requested_at)
       VALUES ($1, $2::bigint, 'ENGLISH', 'openai', 'gpt-4o',
               'mv', 'pv', 1,
               0, 0, 'HIGH', 'n',
               $3::jsonb, '[]'::jsonb, 'h', 'baseline-only', NOW())`,
      [
        CUSTOMER_ID,
        "888",
        JSON.stringify([{ index: 1, aiceId: "aice-9", eventKey: "777" }]),
      ],
    );
    const { rows } = await customerPool.query<{ story_id: string }>(
      `SELECT story_id::text AS story_id
         FROM story_analysis_result
        WHERE customer_id = $1
          AND input_event_refs @> $2::jsonb
          AND superseded_at IS NULL`,
      [CUSTOMER_ID, JSON.stringify([{ aiceId: "aice-9", eventKey: "777" }])],
    );
    expect(rows.map((r) => r.story_id)).toEqual(["888"]);
  });

  it("matches a model-bearing ref by exact model and does NOT over-match a different model's leaf (#465)", async () => {
    // The gpt-5.5 leaf is cited by the gpt-4o report's fallback ref → match.
    const hit = await loadCitedByReports({
      customerId: CUSTOMER_ID,
      leaf: {
        kind: "event",
        aiceId: "aice-cov",
        eventKey: "900",
        generation: 1,
        modelName: "openai",
        model: "gpt-5.5",
      },
    });
    expect(hit.map((r) => `${r.period}:${r.bucketDate}`)).toEqual([
      "DAILY:2026-06-01",
    ]);

    // A gpt-4o leaf of the SAME id/generation must NOT match: the stored ref is
    // for gpt-5.5. A naive model-less `@>` would wrongly match here — the
    // model-pinned probe does not.
    const miss = await loadCitedByReports({
      customerId: CUSTOMER_ID,
      leaf: {
        kind: "event",
        aiceId: "aice-cov",
        eventKey: "900",
        generation: 1,
        modelName: "openai",
        model: "gpt-4o",
      },
    });
    expect(miss).toEqual([]);
  });

  it("created the GIN indexes the reverse lookup relies on", async () => {
    const { rows } = await customerPool.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes
        WHERE indexname IN (
          'periodic_report_result_input_event_refs_gin',
          'periodic_report_result_input_story_refs_gin',
          'story_analysis_result_input_event_refs_gin')`,
    );
    expect(rows.map((r) => r.indexname).sort()).toEqual([
      "periodic_report_result_input_event_refs_gin",
      "periodic_report_result_input_story_refs_gin",
      "story_analysis_result_input_event_refs_gin",
    ]);
  });
});
