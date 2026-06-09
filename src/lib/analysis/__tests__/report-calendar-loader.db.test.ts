// #505 — temporal report navigation loaders (cross-DB) DB tests.
//
// Exercises the pure query paths of `report-calendar-loader`:
//   - `discoverCalendarBuckets` enumerates a viewport (one month / one year)
//     and classifies each bucket has-report / none / out-of-retention /
//     future, grounding has-report on a non-superseded default-variant
//     RESULT row (any language), NOT a state value.
//   - the customer retention provider derives the boundary from
//     `customer_retention_policy.analysis_days` (NULL ⇒ unbounded) using the
//     bucket-start ≥ today−analysis_days rule.
//   - `loadReportNeighbors` resolves the nearest has-report bucket on either
//     side, clamped to the retention boundary on the older side.
//
// The auth preamble (cookie / JWT / session / authorize) is covered by the
// page unit test; here the auth modules are stubbed and we call the pure
// functions directly with the two test pools.

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

const { discoverCalendarBuckets, loadReportNeighbors } = await import(
  "../report-calendar-loader"
);
const { createCustomerRetentionProvider, computeBoundaryDate } = await import(
  "../subject-retention-provider"
);

const AUTH_MIGRATIONS_DIR = join(process.cwd(), "migrations", "auth");
const CUSTOMER_MIGRATIONS_DIR = join(process.cwd(), "migrations", "customer");
const AUTH_LOCK_ID = 3711;
const CUSTOMER_LOCK_ID = 3712;
const CUSTOMER_ID = "00000000-0000-0000-0000-0000000005a9";
const ACTOR = "00000000-0000-0000-0000-0000000005ff";
const TZ = "Asia/Seoul";

// A provider stub with a fixed boundary + today, for deterministic
// classification independent of the real policy read.
function stubProvider(oldestNavigableDate: string | null, today: string) {
  return { resolveBoundary: async () => ({ oldestNavigableDate, today }) };
}

describe.skipIf(!hasPostgres)("report calendar loader (cross-DB)", () => {
  let authDbName: string;
  let authPool: Pool;
  let customerDbName: string;
  let customerPool: Pool;

  async function seedResult(args: {
    period: string;
    bucketDate: string;
    tz?: string;
    lang?: string;
    generation: number;
    superseded?: boolean;
  }): Promise<void> {
    await customerPool.query(
      `INSERT INTO periodic_report_result
         (subject_id, period, bucket_date, tz, lang, model_name, model,
          model_actual_version, prompt_version, generation,
          aggregate_severity_score, aggregate_likelihood_score,
          aggregate_ttp_tags, priority_tier, sections_jsonb,
          input_event_refs, input_story_refs, input_hash,
          redaction_policy_version, requested_by, superseded_at)
       VALUES ($1, $2, $3::date, $4, $5, 'openai', 'gpt-4o',
               'mv', 'pv', $6,
               0, 0,
               '[]'::jsonb, 'LOW', '{}'::jsonb,
               '[]'::jsonb, '[]'::jsonb, 'h',
               'baseline-only', NULL,
               CASE WHEN $7::boolean THEN NOW() ELSE NULL END)`,
      [
        CUSTOMER_ID,
        args.period,
        args.bucketDate,
        args.tz ?? TZ,
        args.lang ?? "ENGLISH",
        args.generation,
        args.superseded ?? false,
      ],
    );
  }

  function cellState(
    cells: Array<{ bucketDate: string; state: string }>,
    bucketDate: string,
  ): string | undefined {
    return cells.find((c) => c.bucketDate === bucketDate)?.state;
  }

  beforeAll(async () => {
    const auth = await createTestDatabase("report_calendar_auth");
    authDbName = auth.dbName;
    authPool = auth.pool;
    await runMigrations(authPool, AUTH_MIGRATIONS_DIR, AUTH_LOCK_ID);

    const cust = await createTestDatabase("report_calendar_cust");
    customerDbName = cust.dbName;
    customerPool = cust.pool;
    await runMigrations(
      customerPool,
      CUSTOMER_MIGRATIONS_DIR,
      CUSTOMER_LOCK_ID,
    );

    await authPool.query(
      `INSERT INTO customers (id, external_key, name, database_status, timezone)
       VALUES ($1, 'rc-1', 'RC Customer', 'active', $2)`,
      [CUSTOMER_ID, TZ],
    );

    // DAILY results across May 2026: 10th, 12th, 20th have a report; the
    // 27th's only result is superseded → still "none".
    await seedResult({
      period: "DAILY",
      bucketDate: "2026-05-10",
      generation: 1,
    });
    await seedResult({
      period: "DAILY",
      bucketDate: "2026-05-12",
      generation: 1,
    });
    await seedResult({
      period: "DAILY",
      bucketDate: "2026-05-20",
      generation: 1,
    });
    await seedResult({
      period: "DAILY",
      bucketDate: "2026-05-27",
      generation: 1,
      superseded: true,
    });
    // A KOREAN-only result on the 15th must still count as has-report (any
    // language resolves via the fallback chain).
    await seedResult({
      period: "DAILY",
      bucketDate: "2026-05-15",
      lang: "KOREAN",
      generation: 1,
    });

    // WEEKLY: the week starting 2026-05-11 (a Monday) has a report.
    await seedResult({
      period: "WEEKLY",
      bucketDate: "2026-05-11",
      generation: 1,
    });
    // MONTHLY: May and June 2026 have reports.
    await seedResult({
      period: "MONTHLY",
      bucketDate: "2026-05-01",
      generation: 1,
    });
    await seedResult({
      period: "MONTHLY",
      bucketDate: "2026-06-01",
      generation: 1,
    });
  }, 30_000);

  afterAll(async () => {
    await authPool?.end();
    await customerPool?.end();
    if (authDbName) await dropTestDatabase(authDbName);
    if (customerDbName) await dropTestDatabase(customerDbName);
    await closeAdminPool();
  });

  it("classifies a DAILY month viewport with boundary + future", async () => {
    // today = 2026-05-21, boundary = 2026-05-11 (analysis_days=10 effect).
    const data = await discoverCalendarBuckets({
      authPool,
      customerPool,
      subjectId: CUSTOMER_ID,
      period: "DAILY",
      viewport: { kind: "month", year: 2026, month: 5 },
      provider: stubProvider("2026-05-11", "2026-05-21"),
    });

    expect(data.cells).toHaveLength(31);
    // has-report (within retention, result present, any language).
    expect(cellState(data.cells, "2026-05-12")).toBe("has-report");
    expect(cellState(data.cells, "2026-05-15")).toBe("has-report");
    expect(cellState(data.cells, "2026-05-20")).toBe("has-report");
    // 2026-05-10 result exists but is BEFORE the boundary → out-of-retention.
    expect(cellState(data.cells, "2026-05-10")).toBe("out-of-retention");
    // No result, within retention, not future → none.
    expect(cellState(data.cells, "2026-05-13")).toBe("none");
    // After today (2026-05-21) → future.
    expect(cellState(data.cells, "2026-05-22")).toBe("future");
    expect(cellState(data.cells, "2026-05-27")).toBe("future");
    // The has-report cell carries the tz to pin.
    const day12 = data.cells.find((c) => c.bucketDate === "2026-05-12");
    expect(day12?.tz).toBe(TZ);
  });

  it("treats a superseded-only bucket as none, not has-report", async () => {
    // today after the 27th so it is neither future nor out-of-retention; its
    // only result is superseded → none.
    const data = await discoverCalendarBuckets({
      authPool,
      customerPool,
      subjectId: CUSTOMER_ID,
      period: "DAILY",
      viewport: { kind: "month", year: 2026, month: 5 },
      provider: stubProvider(null, "2026-06-30"),
    });
    expect(cellState(data.cells, "2026-05-27")).toBe("none");
  });

  it("derives the boundary from the customer retention policy", async () => {
    // analysis_days = 30, today = 2026-06-09 ⇒ boundary 2026-05-10.
    await authPool.query(
      `INSERT INTO customer_retention_policy
         (customer_id, ingestion_days, analysis_days, updated_by)
       VALUES ($1, 365, 30, $2)
       ON CONFLICT (customer_id) DO UPDATE
         SET analysis_days = EXCLUDED.analysis_days`,
      [CUSTOMER_ID, ACTOR],
    );
    const provider = createCustomerRetentionProvider(
      CUSTOMER_ID,
      authPool,
      () => new Date("2026-06-09T00:00:00Z"),
    );
    const { oldestNavigableDate } = await provider.resolveBoundary("DAILY");
    expect(oldestNavigableDate).toBe("2026-05-10");

    const data = await discoverCalendarBuckets({
      authPool,
      customerPool,
      subjectId: CUSTOMER_ID,
      period: "DAILY",
      viewport: { kind: "month", year: 2026, month: 5 },
      provider,
    });
    // 2026-05-10 → in (≥ boundary); 2026-05-09 → out.
    expect(cellState(data.cells, "2026-05-10")).toBe("has-report");
    expect(cellState(data.cells, "2026-05-09")).toBe("out-of-retention");
  });

  it("treats analysis_days = NULL as unbounded retention", async () => {
    await authPool.query(
      `UPDATE customer_retention_policy SET analysis_days = NULL
        WHERE customer_id = $1`,
      [CUSTOMER_ID],
    );
    const provider = createCustomerRetentionProvider(
      CUSTOMER_ID,
      authPool,
      () => new Date("2026-06-09T00:00:00Z"),
    );
    const { oldestNavigableDate } = await provider.resolveBoundary("DAILY");
    expect(oldestNavigableDate).toBeNull();
  });

  it("enumerates WEEKLY and MONTHLY year viewports", async () => {
    const weekly = await discoverCalendarBuckets({
      authPool,
      customerPool,
      subjectId: CUSTOMER_ID,
      period: "WEEKLY",
      viewport: { kind: "year", year: 2026 },
      provider: stubProvider(null, "2026-12-31"),
    });
    expect(weekly.cells.length).toBeGreaterThanOrEqual(52);
    expect(cellState(weekly.cells, "2026-05-11")).toBe("has-report");

    const monthly = await discoverCalendarBuckets({
      authPool,
      customerPool,
      subjectId: CUSTOMER_ID,
      period: "MONTHLY",
      viewport: { kind: "year", year: 2026 },
      provider: stubProvider(null, "2026-12-31"),
    });
    expect(monthly.cells).toHaveLength(12);
    expect(cellState(monthly.cells, "2026-05-01")).toBe("has-report");
    expect(cellState(monthly.cells, "2026-06-01")).toBe("has-report");
    expect(cellState(monthly.cells, "2026-07-01")).toBe("none");
  });

  it("resolves nearest prev/next has-report neighbors", async () => {
    // Unbounded retention (analysis_days NULL set above). DAILY reports on
    // 10/12/15/20. From the 15th → prev 12, next 20.
    const mid = await loadReportNeighbors({
      authPool,
      customerPool,
      subjectId: CUSTOMER_ID,
      period: "DAILY",
      bucketDate: "2026-05-15",
      provider: stubProvider(null, "2026-06-09"),
    });
    expect(mid.prev?.bucketDate).toBe("2026-05-12");
    expect(mid.next?.bucketDate).toBe("2026-05-20");
    expect(mid.olderStop).toBe(false);

    // From the newest (20th) → no next; prev is 15.
    const newest = await loadReportNeighbors({
      authPool,
      customerPool,
      subjectId: CUSTOMER_ID,
      period: "DAILY",
      bucketDate: "2026-05-20",
      provider: stubProvider(null, "2026-06-09"),
    });
    expect(newest.prev?.bucketDate).toBe("2026-05-15");
    expect(newest.next).toBeNull();
  });

  it("stops prev at the retention boundary", async () => {
    // Boundary 2026-05-13: the 10th/12th reports are out of retention, so
    // from the 15th the older step finds nothing → olderStop.
    const n = await loadReportNeighbors({
      authPool,
      customerPool,
      subjectId: CUSTOMER_ID,
      period: "DAILY",
      bucketDate: "2026-05-15",
      provider: stubProvider("2026-05-13", "2026-06-09"),
    });
    expect(n.prev).toBeNull();
    expect(n.olderStop).toBe(true);
    expect(n.next?.bucketDate).toBe("2026-05-20");
  });

  it("returns no neighbors for LIVE", async () => {
    const n = await loadReportNeighbors({
      authPool,
      customerPool,
      subjectId: CUSTOMER_ID,
      period: "LIVE",
      bucketDate: "1970-01-01",
      provider: stubProvider(null, "2026-06-09"),
    });
    expect(n).toEqual({ prev: null, next: null, olderStop: false });
  });

  it("computeBoundaryDate applies calendar-day subtraction", () => {
    expect(computeBoundaryDate("2026-06-09", 30)).toBe("2026-05-10");
    expect(computeBoundaryDate("2026-03-01", 1)).toBe("2026-02-28");
  });
});
