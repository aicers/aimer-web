// #369 — periodic report index loader DB tests (cross-DB discovery).
//
// Exercises the staged query path of `discoverReportBuckets`:
//   - discovery reads non-archived `periodic_report_state` rows (auth DB),
//     excludes `archived`, and caps each period in SQL
//   - LIVE collapses to the most-recently-updated rolling row
//   - enrichment joins the customer-DB `periodic_report_result` latest
//     non-superseded DEFAULT variant, matched on the row's own `tz`
//   - a missing result leaves the bucket as links-only ("being generated")
//
// The auth preamble (cookie / JWT / session / authorize) is covered by the
// page unit test; here the auth modules are stubbed so the module imports
// cleanly in the node test env and we call `discoverReportBuckets` directly
// with the two test pools.

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
vi.mock("@/lib/auth/authorization", () => ({ authorize: vi.fn() }));

// Shrink the DAILY cap before the module computes PERIOD_CAPS at import so
// the cap is testable with a small fixture.
process.env.ANALYSIS_REPORT_INDEX_CAP_DAILY = "2";

const { discoverReportBuckets } = await import("../report-index-page-loader");

const AUTH_MIGRATIONS_DIR = join(process.cwd(), "migrations", "auth");
const CUSTOMER_MIGRATIONS_DIR = join(process.cwd(), "migrations", "customer");
const AUTH_LOCK_ID = 3691;
const CUSTOMER_LOCK_ID = 3692;
const CUSTOMER_ID = "00000000-0000-0000-0000-0000000003a9";
const TZ = "Asia/Seoul";
const OTHER_TZ = "America/New_York";

describe.skipIf(!hasPostgres)("report index loader (cross-DB)", () => {
  let authDbName: string;
  let authPool: Pool;
  let customerDbName: string;
  let customerPool: Pool;

  async function seedState(
    period: string,
    bucketDate: string,
    tz: string,
    status: string,
    updatedAt?: string,
  ): Promise<void> {
    await authPool.query(
      `INSERT INTO periodic_report_state
         (customer_id, period, bucket_date, tz, status, updated_at)
       VALUES ($1, $2, $3::date, $4, $5, COALESCE($6::timestamptz, NOW()))
       ON CONFLICT (customer_id, period, bucket_date, tz)
       DO UPDATE SET status = EXCLUDED.status, updated_at = EXCLUDED.updated_at`,
      [CUSTOMER_ID, period, bucketDate, tz, status, updatedAt ?? null],
    );
  }

  async function seedResult(args: {
    period: string;
    bucketDate: string;
    tz: string;
    lang?: string;
    modelName?: string;
    model?: string;
    generation: number;
    tier: string;
    superseded?: boolean;
    requestedBy?: string | null;
  }): Promise<void> {
    await customerPool.query(
      `INSERT INTO periodic_report_result
         (customer_id, period, bucket_date, tz, lang, model_name, model,
          model_actual_version, prompt_version, generation,
          aggregate_severity_score, aggregate_likelihood_score,
          aggregate_ttp_tags, priority_tier, sections_jsonb,
          input_event_refs, input_story_refs, input_hash,
          redaction_policy_version, requested_by, superseded_at)
       VALUES ($1, $2, $3::date, $4, $5, $6, $7,
               'mv', 'pv', $8,
               0, 0,
               '[]'::jsonb, $9, '{}'::jsonb,
               '[]'::jsonb, '[]'::jsonb, 'h',
               'baseline-only', $10::uuid,
               CASE WHEN $11::boolean THEN NOW() ELSE NULL END)`,
      [
        CUSTOMER_ID,
        args.period,
        args.bucketDate,
        args.tz,
        args.lang ?? "ENGLISH",
        args.modelName ?? "openai",
        args.model ?? "gpt-4o",
        args.generation,
        args.tier,
        args.requestedBy ?? null,
        args.superseded ?? false,
      ],
    );
  }

  beforeAll(async () => {
    const auth = await createTestDatabase("report_index_auth");
    authDbName = auth.dbName;
    authPool = auth.pool;
    await runMigrations(authPool, AUTH_MIGRATIONS_DIR, AUTH_LOCK_ID);

    const cust = await createTestDatabase("report_index_cust");
    customerDbName = cust.dbName;
    customerPool = cust.pool;
    await runMigrations(
      customerPool,
      CUSTOMER_MIGRATIONS_DIR,
      CUSTOMER_LOCK_ID,
    );

    await authPool.query(
      `INSERT INTO customers (id, external_key, name, database_status, timezone)
       VALUES ($1, 'ri-1', 'RI Customer', 'active', $2)`,
      [CUSTOMER_ID, TZ],
    );

    // --- State rows (auth DB) ---
    // DAILY: three non-archived (cap 2 keeps the two most recent) + one
    // archived (always excluded).
    await seedState("DAILY", "2026-05-27", TZ, "ready");
    await seedState("DAILY", "2026-05-26", TZ, "pending");
    await seedState("DAILY", "2026-05-25", TZ, "ready");
    await seedState("DAILY", "2026-05-24", TZ, "archived");
    // LIVE: two rows on different tz; cap 1 keeps the most recently updated.
    await seedState(
      "LIVE",
      "1970-01-01",
      OTHER_TZ,
      "ready",
      "2026-05-27T00:00:00Z",
    );
    await seedState("LIVE", "1970-01-01", TZ, "ready", "2026-05-27T12:00:00Z");
    // WEEKLY dirty + MONTHLY ready, one each.
    await seedState("WEEKLY", "2026-05-25", TZ, "dirty");
    await seedState("MONTHLY", "2026-05-01", TZ, "ready");

    // --- Result rows (customer DB) ---
    // DAILY 2026-05-27: gen 1 superseded, gen 2 current → enrichment picks
    // gen 2. A KOREAN (non-default) variant and an OTHER_TZ result must be
    // ignored.
    await seedResult({
      period: "DAILY",
      bucketDate: "2026-05-27",
      tz: TZ,
      generation: 1,
      tier: "LOW",
      superseded: true,
    });
    await seedResult({
      period: "DAILY",
      bucketDate: "2026-05-27",
      tz: TZ,
      generation: 2,
      tier: "HIGH",
    });
    await seedResult({
      period: "DAILY",
      bucketDate: "2026-05-27",
      tz: TZ,
      lang: "KOREAN",
      generation: 5,
      tier: "CRITICAL",
    });
    await seedResult({
      period: "DAILY",
      bucketDate: "2026-05-27",
      tz: OTHER_TZ,
      generation: 9,
      tier: "CRITICAL",
    });
    // DAILY 2026-05-26: no result → "being generated".
    // WEEKLY 2026-05-25: a current result.
    await seedResult({
      period: "WEEKLY",
      bucketDate: "2026-05-25",
      tz: TZ,
      generation: 1,
      tier: "MEDIUM",
    });
  }, 30_000);

  afterAll(async () => {
    await dropTestDatabase(authDbName, authPool);
    await dropTestDatabase(customerDbName, customerPool);
    await closeAdminPool();
  }, 30_000);

  it("groups buckets in LIVE → DAILY → WEEKLY → MONTHLY order", async () => {
    const groups = await discoverReportBuckets(
      authPool,
      customerPool,
      CUSTOMER_ID,
    );
    expect(groups.map((g) => g.period)).toEqual([
      "LIVE",
      "DAILY",
      "WEEKLY",
      "MONTHLY",
    ]);
  });

  it("caps DAILY to 2, newest first, and excludes the archived bucket", async () => {
    const groups = await discoverReportBuckets(
      authPool,
      customerPool,
      CUSTOMER_ID,
    );
    const daily = groups.find((g) => g.period === "DAILY");
    expect(daily?.items.map((i) => i.bucketDate)).toEqual([
      "2026-05-27",
      "2026-05-26",
    ]);
  });

  it("collapses LIVE to the most-recently-updated rolling row's tz", async () => {
    const groups = await discoverReportBuckets(
      authPool,
      customerPool,
      CUSTOMER_ID,
    );
    const live = groups.find((g) => g.period === "LIVE");
    expect(live?.items).toHaveLength(1);
    expect(live?.items[0].tz).toBe(TZ);
  });

  it("enriches with the latest non-superseded default variant only", async () => {
    const groups = await discoverReportBuckets(
      authPool,
      customerPool,
      CUSTOMER_ID,
    );
    const daily = groups.find((g) => g.period === "DAILY");
    const may27 = daily?.items.find((i) => i.bucketDate === "2026-05-27");
    // gen 2 (HIGH) wins over the superseded gen 1 and the KOREAN/OTHER_TZ
    // rows are ignored.
    expect(may27?.result?.generation).toBe(2);
    expect(may27?.result?.priorityTier).toBe("HIGH");
    expect(may27?.tz).toBe(TZ);
  });

  it("leaves a bucket with no default-variant result as links-only", async () => {
    const groups = await discoverReportBuckets(
      authPool,
      customerPool,
      CUSTOMER_ID,
    );
    const daily = groups.find((g) => g.period === "DAILY");
    const may26 = daily?.items.find((i) => i.bucketDate === "2026-05-26");
    expect(may26?.result).toBeNull();
    expect(may26?.stateStatus).toBe("pending");
  });

  it("carries the dirty state status through for the WEEKLY bucket", async () => {
    const groups = await discoverReportBuckets(
      authPool,
      customerPool,
      CUSTOMER_ID,
    );
    const weekly = groups.find((g) => g.period === "WEEKLY");
    expect(weekly?.items[0].stateStatus).toBe("dirty");
    expect(weekly?.items[0].result?.priorityTier).toBe("MEDIUM");
  });

  it("returns an empty array for a customer with no tracked buckets", async () => {
    const groups = await discoverReportBuckets(
      authPool,
      customerPool,
      "00000000-0000-0000-0000-0000000000ff",
    );
    expect(groups).toEqual([]);
  });
});
