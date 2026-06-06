// DB tests for the cross-customer overview per-customer fetchers (WS2, #391).
//
// Exercises the SQL the unit test cannot (it fakes the pools):
//   - events: canonical row per (aice_id, event_key) — latest generation,
//     not superseded, default variant only; tier-rank ordering; window count
//   - stories: `story_analysis_state` lifecycle exclusion (archived + pending
//     dropped, ready/dirty kept) with customer-DB score enrichment; the
//     disclosure count is the full ready/dirty set
//   - reports: auth-DB `periodic_report_state` discovery (archived buckets
//     excluded from items AND count) + customer-DB canonical dedup + tier-rank
//
// The auth preamble (cookie / JWT / session) is not exercised here — these
// fetchers take pools directly — so those modules are stubbed only so the
// module imports cleanly in the node test env.

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
vi.mock("@/lib/auth/cookies", () => ({ getAuthCookie: vi.fn() }));
vi.mock("@/lib/auth/jwt", () => ({ verifyJwtFull: vi.fn() }));
vi.mock("@/lib/auth/session-policy", () => ({ getSessionPolicy: vi.fn() }));
vi.mock("@/lib/auth/session-validator", () => ({ validateSession: vi.fn() }));
vi.mock("@/lib/auth/authorization", () => ({
  listAccessibleCustomersDetailed: vi.fn(),
}));
vi.mock("@/lib/db/client", () => ({
  getAuthPool: vi.fn(),
  withTransaction: vi.fn(),
}));
vi.mock("@/lib/db/customer-runtime-pool", () => ({
  getCustomerRuntimePool: vi.fn(),
}));

const { fetchCustomerEvents, fetchCustomerStories, fetchCustomerReports } =
  await import("../cross-customer-overview");

const AUTH_MIGRATIONS_DIR = join(process.cwd(), "migrations", "auth");
const CUSTOMER_MIGRATIONS_DIR = join(process.cwd(), "migrations", "customer");
const AUTH_LOCK_ID = 3693;
const CUSTOMER_LOCK_ID = 3694;
const CUSTOMER_ID = "00000000-0000-0000-0000-0000000004a1";
const NAME = "XC Customer";
// A second customer used only by the fetch-cap boundary tests, so its seeds
// don't perturb the counts asserted by the lifecycle tests above.
const BOUNDARY_CUSTOMER_ID = "00000000-0000-0000-0000-0000000004b2";
const BOUNDARY_NAME = "XC Boundary";
// A third customer for the story recency-tiebreak test: several lifecycle-
// eligible stories that tie on tier/severity/likelihood but differ in
// `last_ready_at`, so the pre-limit order must rank by recency (not the
// `story_id` tiebreak) to keep the newest eligible stories.
const RECENCY_CUSTOMER_ID = "00000000-0000-0000-0000-0000000004c3";
const RECENCY_NAME = "XC Recency";

describe.skipIf(!hasPostgres)("cross-customer overview fetchers", () => {
  let authDbName: string;
  let authPool: Pool;
  let customerDbName: string;
  let customerPool: Pool;

  async function seedEvent(args: {
    aiceId: string;
    eventKey: string;
    lang?: string;
    modelName?: string;
    model?: string;
    generation: number;
    tier: string;
    severity?: number;
    likelihood?: number;
    superseded?: boolean;
  }): Promise<void> {
    await customerPool.query(
      `INSERT INTO event_analysis_result
         (aice_id, event_key, lang, model_name, model,
          model_actual_version, prompt_version,
          severity_score, likelihood_score,
          severity_factors, likelihood_factors, ttp_tags,
          priority_tier, analysis_text, redaction_policy_version,
          requested_by, generation, superseded_at)
       VALUES ($1, $2::numeric, $3, $4, $5,
               'mv', 'pv',
               $6, $7,
               '[]'::jsonb, '[]'::jsonb, '[]'::jsonb,
               $8, 'text', 'baseline-only',
               '00000000-0000-0000-0000-0000000000aa'::uuid, $9,
               CASE WHEN $10::boolean THEN NOW() ELSE NULL END)`,
      [
        args.aiceId,
        args.eventKey,
        args.lang ?? "ENGLISH",
        args.modelName ?? "openai",
        args.model ?? "gpt-4o",
        args.severity ?? 0.5,
        args.likelihood ?? 0.5,
        args.tier,
        args.generation,
        args.superseded ?? false,
      ],
    );
  }

  async function seedStoryState(
    storyId: string,
    status: string,
    lastReadyAt?: string,
    customerId: string = CUSTOMER_ID,
  ): Promise<void> {
    await authPool.query(
      `INSERT INTO story_analysis_state
         (customer_id, story_id, status, last_ready_at, updated_at)
       VALUES ($1, $2::bigint, $3, $4::timestamptz, NOW())`,
      [customerId, storyId, status, lastReadyAt ?? null],
    );
  }

  async function seedStoryResult(args: {
    storyId: string;
    lang?: string;
    modelName?: string;
    model?: string;
    generation: number;
    tier: string;
    severity?: number;
    likelihood?: number;
    superseded?: boolean;
    customerId?: string;
  }): Promise<void> {
    await customerPool.query(
      `INSERT INTO story_analysis_result
         (customer_id, story_id, lang, model_name, model,
          model_actual_version, prompt_version, generation,
          severity_score, likelihood_score,
          severity_factors, likelihood_factors, ttp_tags,
          priority_tier, analysis_text, input_event_refs, input_fact_refs,
          input_hash, redaction_policy_version, requested_by, superseded_at)
       VALUES ($1, $2::bigint, $3, $4, $5,
               'mv', 'pv', $6,
               $7, $8,
               '[]'::jsonb, '[]'::jsonb, '[]'::jsonb,
               $9, 'text', '[]'::jsonb, '[]'::jsonb, 'h',
               'baseline-only', NULL,
               CASE WHEN $10::boolean THEN NOW() ELSE NULL END)`,
      [
        args.customerId ?? CUSTOMER_ID,
        args.storyId,
        args.lang ?? "ENGLISH",
        args.modelName ?? "openai",
        args.model ?? "gpt-4o",
        args.generation,
        args.severity ?? 0.5,
        args.likelihood ?? 0.5,
        args.tier,
        args.superseded ?? false,
      ],
    );
  }

  async function seedReportState(args: {
    period: string;
    bucketDate: string;
    tz?: string;
    status: string;
    customerId?: string;
  }): Promise<void> {
    await authPool.query(
      `INSERT INTO periodic_report_state
         (customer_id, period, bucket_date, tz, status)
       VALUES ($1, $2, $3::date, $4, $5)`,
      [
        args.customerId ?? CUSTOMER_ID,
        args.period,
        args.bucketDate,
        args.tz ?? "UTC",
        args.status,
      ],
    );
  }

  async function seedReport(args: {
    period: string;
    bucketDate: string;
    tz?: string;
    generation: number;
    tier: string;
    severity?: number;
    likelihood?: number;
    superseded?: boolean;
    customerId?: string;
  }): Promise<void> {
    await customerPool.query(
      `INSERT INTO periodic_report_result
         (customer_id, period, bucket_date, tz, lang, model_name, model,
          model_actual_version, prompt_version, generation,
          aggregate_severity_score, aggregate_likelihood_score,
          aggregate_ttp_tags, priority_tier, sections_jsonb,
          input_event_refs, input_story_refs, input_hash,
          redaction_policy_version, requested_by, superseded_at)
       VALUES ($1, $2, $3::date, $4, 'ENGLISH', 'openai', 'gpt-4o',
               'mv', 'pv', $5,
               $6, $7,
               '[]'::jsonb, $8, '{}'::jsonb,
               '[]'::jsonb, '[]'::jsonb, 'h',
               'baseline-only', NULL,
               CASE WHEN $9::boolean THEN NOW() ELSE NULL END)`,
      [
        args.customerId ?? CUSTOMER_ID,
        args.period,
        args.bucketDate,
        args.tz ?? "UTC",
        args.generation,
        args.severity ?? 0,
        args.likelihood ?? 0,
        args.tier,
        args.superseded ?? false,
      ],
    );
  }

  beforeAll(async () => {
    const auth = await createTestDatabase("xc_overview_auth");
    authDbName = auth.dbName;
    authPool = auth.pool;
    await runMigrations(authPool, AUTH_MIGRATIONS_DIR, AUTH_LOCK_ID);

    const cust = await createTestDatabase("xc_overview_cust");
    customerDbName = cust.dbName;
    customerPool = cust.pool;
    await runMigrations(
      customerPool,
      CUSTOMER_MIGRATIONS_DIR,
      CUSTOMER_LOCK_ID,
    );

    await authPool.query(
      `INSERT INTO customers (id, external_key, name, database_status, timezone)
       VALUES ($1, 'xc-1', $2, 'active', 'UTC'),
              ($3, 'xc-2', $4, 'active', 'UTC'),
              ($5, 'xc-3', $6, 'active', 'UTC')`,
      [
        CUSTOMER_ID,
        NAME,
        BOUNDARY_CUSTOMER_ID,
        BOUNDARY_NAME,
        RECENCY_CUSTOMER_ID,
        RECENCY_NAME,
      ],
    );

    // --- Events: canonical dedup + non-default variant exclusion. ---
    // (aice1, ev1): gen1 default LOW superseded, gen2 default CRITICAL live.
    await seedEvent({
      aiceId: "aice1",
      eventKey: "1",
      generation: 1,
      tier: "LOW",
      superseded: true,
    });
    await seedEvent({
      aiceId: "aice1",
      eventKey: "1",
      generation: 2,
      tier: "CRITICAL",
    });
    // Non-default KOREAN variant for the same event — must be ignored.
    await seedEvent({
      aiceId: "aice1",
      eventKey: "1",
      lang: "KOREAN",
      generation: 1,
      tier: "CRITICAL",
    });
    // (aice2, ev2): single default MEDIUM.
    await seedEvent({
      aiceId: "aice2",
      eventKey: "2",
      generation: 1,
      tier: "MEDIUM",
    });

    // --- Stories: lifecycle exclusion. ---
    await seedStoryState("100", "ready", "2026-06-01T00:00:00Z");
    await seedStoryState("200", "dirty", "2026-06-02T00:00:00Z");
    await seedStoryState("300", "archived", "2026-06-03T00:00:00Z");
    await seedStoryState("400", "pending");
    // Results: s100 HIGH (gen1 LOW superseded, gen2 HIGH live), s200 CRITICAL,
    // s300 LOW (present but archived → excluded by the state filter).
    await seedStoryResult({
      storyId: "100",
      generation: 1,
      tier: "LOW",
      superseded: true,
    });
    await seedStoryResult({ storyId: "100", generation: 2, tier: "HIGH" });
    await seedStoryResult({ storyId: "200", generation: 1, tier: "CRITICAL" });
    await seedStoryResult({ storyId: "300", generation: 1, tier: "LOW" });

    // --- Reports: discover/enrich (auth state is the source of truth). ---
    // DAILY 2026-06-01: gen1 LOW superseded, gen2 HIGH live; state ready.
    // WEEKLY 2026-05-25: CRITICAL; state ready.
    // MONTHLY 2026-04-01: CRITICAL result lingering, but state ARCHIVED — must
    //   be excluded from both items and count (its detail link would 404).
    await seedReportState({
      period: "DAILY",
      bucketDate: "2026-06-01",
      status: "ready",
    });
    await seedReportState({
      period: "WEEKLY",
      bucketDate: "2026-05-25",
      status: "ready",
    });
    await seedReportState({
      period: "MONTHLY",
      bucketDate: "2026-04-01",
      status: "archived",
    });
    await seedReport({
      period: "DAILY",
      bucketDate: "2026-06-01",
      generation: 1,
      tier: "LOW",
      superseded: true,
    });
    await seedReport({
      period: "DAILY",
      bucketDate: "2026-06-01",
      generation: 2,
      tier: "HIGH",
    });
    await seedReport({
      period: "WEEKLY",
      bucketDate: "2026-05-25",
      generation: 1,
      tier: "CRITICAL",
    });
    await seedReport({
      period: "MONTHLY",
      bucketDate: "2026-04-01",
      generation: 1,
      tier: "CRITICAL",
    });

    // --- Fetch-cap boundary (BOUNDARY_CUSTOMER_ID) ---
    // The lifecycle intersection must be applied BEFORE the risk LIMIT, or
    // archived/pending rows that out-rank the eligible ones by priority can
    // fill the over-fetch window and hide an eligible high-risk row. Each
    // surface seeds several archived CRITICAL rows that sort AHEAD of one
    // ready CRITICAL row (higher severity, lower story_id/bucket_date). With a
    // fetch cap of 2, a rank-then-filter implementation would pick two
    // archived rows and drop them, returning nothing; intersect-then-rank
    // returns the eligible row.
    for (const storyId of ["9001", "9002", "9003"]) {
      await seedStoryState(
        storyId,
        "archived",
        "2026-06-01T00:00:00Z",
        BOUNDARY_CUSTOMER_ID,
      );
      await seedStoryResult({
        storyId,
        generation: 1,
        tier: "CRITICAL",
        severity: 0.9,
        likelihood: 0.9,
        customerId: BOUNDARY_CUSTOMER_ID,
      });
    }
    await seedStoryState(
      "9100",
      "ready",
      "2026-06-02T00:00:00Z",
      BOUNDARY_CUSTOMER_ID,
    );
    await seedStoryResult({
      storyId: "9100",
      generation: 1,
      tier: "CRITICAL",
      severity: 0.5,
      likelihood: 0.5,
      customerId: BOUNDARY_CUSTOMER_ID,
    });

    for (const bucketDate of ["2026-05-01", "2026-05-02", "2026-05-03"]) {
      await seedReportState({
        period: "DAILY",
        bucketDate,
        status: "archived",
        customerId: BOUNDARY_CUSTOMER_ID,
      });
      await seedReport({
        period: "DAILY",
        bucketDate,
        generation: 1,
        tier: "CRITICAL",
        severity: 0.9,
        likelihood: 0.9,
        customerId: BOUNDARY_CUSTOMER_ID,
      });
    }
    await seedReportState({
      period: "DAILY",
      bucketDate: "2026-05-10",
      status: "ready",
      customerId: BOUNDARY_CUSTOMER_ID,
    });
    await seedReport({
      period: "DAILY",
      bucketDate: "2026-05-10",
      generation: 1,
      tier: "CRITICAL",
      severity: 0.5,
      likelihood: 0.5,
      customerId: BOUNDARY_CUSTOMER_ID,
    });

    // --- Story recency tiebreak (RECENCY_CUSTOMER_ID) ---
    // Three ready stories tie on tier/severity/likelihood and differ only in
    // `last_ready_at`, with recency order REVERSED from `story_id` order
    // (oldest id = oldest recency). With a fetch cap of 2, an order that omits
    // recency falls back to `story_id ASC` and keeps the two OLDEST (7001,
    // 7002), dropping the newest eligible story; recency-before-id keeps the
    // two NEWEST (7003, 7002).
    for (const [storyId, lastReadyAt] of [
      ["7001", "2026-06-01T00:00:00Z"],
      ["7002", "2026-06-02T00:00:00Z"],
      ["7003", "2026-06-03T00:00:00Z"],
    ]) {
      await seedStoryState(storyId, "ready", lastReadyAt, RECENCY_CUSTOMER_ID);
      await seedStoryResult({
        storyId,
        generation: 1,
        tier: "CRITICAL",
        severity: 0.7,
        likelihood: 0.7,
        customerId: RECENCY_CUSTOMER_ID,
      });
    }
  }, 30_000);

  afterAll(async () => {
    await dropTestDatabase(authDbName, authPool);
    await dropTestDatabase(customerDbName, customerPool);
    await closeAdminPool();
  }, 30_000);

  it("events: one canonical row per (aice,event), tier-ranked, default-variant only", async () => {
    const { rows, total } = await fetchCustomerEvents(
      customerPool,
      CUSTOMER_ID,
      NAME,
      25,
    );
    expect(total).toBe(2);
    expect(rows.map((r) => `${r.aiceId}:${r.eventKey}`)).toEqual([
      "aice1:1",
      "aice2:2",
    ]);
    // CRITICAL (the live gen2) ranks before MEDIUM, not the superseded LOW.
    expect(rows.map((r) => r.priorityTier)).toEqual(["CRITICAL", "MEDIUM"]);
  });

  it("stories: excludes archived + pending, enriches ready/dirty, tier-ranked", async () => {
    const { rows, total } = await fetchCustomerStories(
      authPool,
      customerPool,
      CUSTOMER_ID,
      NAME,
      25,
    );
    // Only ready (100) + dirty (200) count; archived (300) + pending (400) out.
    expect(total).toBe(2);
    expect(rows.map((r) => r.storyId)).toEqual(["200", "100"]); // CRITICAL > HIGH
    expect(rows.map((r) => r.priorityTier)).toEqual(["CRITICAL", "HIGH"]);
    // No archived story leaks in.
    expect(rows.some((r) => r.storyId === "300")).toBe(false);
  });

  it("reports: state-discover + canonical dedup + tier-rank, excludes archived", async () => {
    const { rows, total } = await fetchCustomerReports(
      authPool,
      customerPool,
      CUSTOMER_ID,
      NAME,
      25,
    );
    // Only the two non-archived (ready) buckets count; the archived MONTHLY
    // bucket whose result still lingers is excluded from both count and rows.
    expect(total).toBe(2);
    expect(rows.map((r) => r.priorityTier)).toEqual(["CRITICAL", "HIGH"]);
    // The superseded gen1 LOW is never the canonical row for the DAILY bucket.
    expect(rows.some((r) => r.priorityTier === "LOW")).toBe(false);
    // No archived bucket leaks in (its detail link would 404).
    expect(rows.some((r) => r.period === "MONTHLY")).toBe(false);
  });

  it("stories: an eligible high-risk row survives when archived rows would exhaust the fetch cap", async () => {
    // fetchCap = 2: three archived CRITICAL stories out-rank the lone ready
    // CRITICAL by severity. Intersecting the lifecycle set before the LIMIT is
    // what keeps the eligible story visible (rank-then-filter would lose it).
    const { rows, total } = await fetchCustomerStories(
      authPool,
      customerPool,
      BOUNDARY_CUSTOMER_ID,
      BOUNDARY_NAME,
      25,
      2,
    );
    // Only the ready story is lifecycle-eligible, so it is both the count and
    // the single returned row — never crowded out by the archived rows.
    expect(total).toBe(1);
    expect(rows.map((r) => r.storyId)).toEqual(["9100"]);
  });

  it("stories: pre-limit order ranks by recency before the id tiebreak", async () => {
    // fetchCap = 2 over three stories tied on tier/severity/likelihood. The
    // customer-DB query must carry the auth-DB recency into its pre-limit
    // order, or it truncates to the lowest ids and drops the newest eligible
    // story. Correct (recency desc, then id asc): the two newest survive.
    const { rows, total } = await fetchCustomerStories(
      authPool,
      customerPool,
      RECENCY_CUSTOMER_ID,
      RECENCY_NAME,
      25,
      2,
    );
    // All three are lifecycle-eligible, so the disclosure count is 3, but the
    // fetch cap keeps the two newest by recency — never the lowest ids.
    expect(total).toBe(3);
    expect(rows.map((r) => r.storyId)).toEqual(["7003", "7002"]);
  });

  it("reports: an eligible high-risk bucket survives when archived buckets would exhaust the fetch cap", async () => {
    const { rows, total } = await fetchCustomerReports(
      authPool,
      customerPool,
      BOUNDARY_CUSTOMER_ID,
      BOUNDARY_NAME,
      25,
      2,
    );
    expect(total).toBe(1);
    expect(rows.map((r) => `${r.period}:${r.bucketDate}`)).toEqual([
      "DAILY:2026-05-10",
    ]);
  });
});
