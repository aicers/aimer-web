// #389 Part A — multi-language eager seed + coalescing on-demand enqueue.
//
// Covers the acceptance criteria:
//   - every report bucket is seeded with the eager language set
//     ({ ENGLISH, localeToLanguage(DEFAULT_LOCALE), WORKER_LANG }), so the
//     default-locale language is seeded eagerly even when English exists;
//   - the on-demand enqueue helper coalesces onto any in-flight/completed
//     job (no generation bump), seeds a fresh row only on a first request,
//     re-queues a failed/dry-run variant, and reports source availability.

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
vi.mock("@/lib/audit", () => ({ auditLog: vi.fn(async () => {}) }));

// Pin the app default locale to `ko` so the eager set is { ENGLISH, KOREAN }
// (WORKER_LANG defaults to ENGLISH). Set before the dynamic import so the
// module reads it at init.
process.env.DEFAULT_LOCALE = "ko";

const { EAGER_LANGS, seedRealReportJobs, enqueueOnDemandReportJob } =
  await import("../report-worker");

const AUTH_MIGRATIONS_DIR = join(process.cwd(), "migrations", "auth");
const AUTH_LOCK_ID = 2511;
const CUSTOMER_ID = "00000000-0000-0000-0000-0000000000f1";
const TZ = "Asia/Seoul";

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

async function jobsForBucket(
  authPool: Pool,
  period: string,
  bucketDate: string,
): Promise<
  Array<{
    lang: string;
    status: string;
    generation: number;
    dry_run: boolean;
  }>
> {
  const { rows } = await authPool.query<{
    lang: string;
    status: string;
    generation: number;
    dry_run: boolean;
  }>(
    `SELECT lang, status, generation, dry_run FROM periodic_report_job
      WHERE customer_id = $1 AND period = $2
        AND bucket_date = $3::date AND tz = $4
      ORDER BY lang`,
    [CUSTOMER_ID, period, bucketDate, TZ],
  );
  return rows;
}

const VARIANT = (overrides: Record<string, unknown> = {}) => ({
  customerId: CUSTOMER_ID,
  period: "DAILY",
  bucketDate: "2026-05-26",
  tz: TZ,
  lang: "KOREAN",
  modelName: "openai",
  model: "gpt-4o",
  ...overrides,
});

describe.skipIf(!hasPostgres)("report worker eager seed + on-demand", () => {
  let authDbName: string;
  let authPool: Pool;

  beforeAll(async () => {
    const auth = await createTestDatabase("report_eager_auth");
    authDbName = auth.dbName;
    authPool = auth.pool;
    await runMigrations(authPool, AUTH_MIGRATIONS_DIR, AUTH_LOCK_ID);
    await authPool.query(
      `INSERT INTO customers (id, external_key, name, database_status, timezone)
       VALUES ($1, 're-1', 'RE Customer', 'active', $2)`,
      [CUSTOMER_ID, TZ],
    );
  }, 30_000);

  afterAll(async () => {
    await dropTestDatabase(authDbName, authPool);
    await closeAdminPool();
  }, 30_000);

  it("eager set resolves to { ENGLISH, KOREAN } under DEFAULT_LOCALE=ko", () => {
    expect([...EAGER_LANGS].sort()).toEqual(["ENGLISH", "KOREAN"]);
  });

  it("seeds every eager language for a fresh ready bucket", async () => {
    await seedState(authPool, "DAILY", "2026-05-26", "ready");

    const client = await authPool.connect();
    try {
      await seedRealReportJobs(client, 10, new Date().toISOString());
    } finally {
      client.release();
    }

    const jobs = await jobsForBucket(authPool, "DAILY", "2026-05-26");
    expect(jobs.map((j) => j.lang)).toEqual(["ENGLISH", "KOREAN"]);
    for (const job of jobs) {
      expect(job.status).toBe("queued");
      expect(job.generation).toBe(1);
      expect(job.dry_run).toBe(false);
    }
  });

  it("seeds the default-locale language even when English already exists", async () => {
    await seedState(authPool, "DAILY", "2026-05-27", "ready");
    // English variant already present (e.g. seeded on an earlier tick).
    await authPool.query(
      `INSERT INTO periodic_report_job
         (customer_id, period, bucket_date, tz, lang, model_name, model,
          status, generation, dry_run)
       VALUES ($1, 'DAILY', '2026-05-27'::date, $2, 'ENGLISH', 'openai', 'gpt-4o',
               'done', 1, FALSE)`,
      [CUSTOMER_ID, TZ],
    );

    const client = await authPool.connect();
    try {
      await seedRealReportJobs(client, 10, new Date().toISOString());
    } finally {
      client.release();
    }

    const jobs = await jobsForBucket(authPool, "DAILY", "2026-05-27");
    const byLang = new Map(jobs.map((j) => [j.lang, j]));
    // English untouched (still done), Korean newly seeded as queued.
    expect(byLang.get("ENGLISH")?.status).toBe("done");
    expect(byLang.get("KOREAN")?.status).toBe("queued");
    expect(byLang.get("KOREAN")?.generation).toBe(1);
  });

  it("eager seed is idempotent across ticks", async () => {
    await seedState(authPool, "DAILY", "2026-05-28", "ready");
    const run = async () => {
      const client = await authPool.connect();
      try {
        await seedRealReportJobs(client, 10, new Date().toISOString());
      } finally {
        client.release();
      }
    };
    await run();
    await run();

    const jobs = await jobsForBucket(authPool, "DAILY", "2026-05-28");
    expect(jobs.map((j) => j.lang)).toEqual(["ENGLISH", "KOREAN"]);
  });

  it("dirty bucket bumps existing variants and seeds missing eager langs", async () => {
    await seedState(authPool, "DAILY", "2026-05-29", "dirty");
    // An English variant already exists at generation 2 (e.g. force-created
    // earlier); the default-locale Korean variant is missing.
    await authPool.query(
      `INSERT INTO periodic_report_job
         (customer_id, period, bucket_date, tz, lang, model_name, model,
          status, generation, dry_run)
       VALUES ($1, 'DAILY', '2026-05-29'::date, $2, 'ENGLISH', 'openai', 'gpt-4o',
               'done', 2, FALSE)`,
      [CUSTOMER_ID, TZ],
    );

    const client = await authPool.connect();
    try {
      await seedRealReportJobs(client, 10, new Date().toISOString());
    } finally {
      client.release();
    }

    const jobs = await jobsForBucket(authPool, "DAILY", "2026-05-29");
    const byLang = new Map(jobs.map((j) => [j.lang, j]));
    // English bumped to generation 3 and re-queued; Korean newly seeded at
    // generation 1.
    expect(byLang.get("ENGLISH")).toMatchObject({
      status: "queued",
      generation: 3,
    });
    expect(byLang.get("KOREAN")).toMatchObject({
      status: "queued",
      generation: 1,
    });
    // The state returns to `ready` once its variant jobs are (re)seeded.
    const { rows } = await authPool.query<{ status: string }>(
      `SELECT status FROM periodic_report_state
        WHERE customer_id = $1 AND period = 'DAILY'
          AND bucket_date = '2026-05-29'::date AND tz = $2`,
      [CUSTOMER_ID, TZ],
    );
    expect(rows[0].status).toBe("ready");
  });

  it("on-demand: first request seeds a generation-1 queued row", async () => {
    await seedState(authPool, "DAILY", "2026-06-10", "ready");

    const res = await enqueueOnDemandReportJob(
      authPool,
      VARIANT({ bucketDate: "2026-06-10" }),
    );

    expect(res).toEqual({ action: "seeded", generation: 1, status: "queued" });
    const jobs = await jobsForBucket(authPool, "DAILY", "2026-06-10");
    const korean = jobs.find((j) => j.lang === "KOREAN");
    expect(korean?.status).toBe("queued");
    expect(korean?.generation).toBe(1);
  });

  it("on-demand: coalesces onto a queued job without bumping generation", async () => {
    await seedState(authPool, "DAILY", "2026-06-11", "ready");
    await authPool.query(
      `INSERT INTO periodic_report_job
         (customer_id, period, bucket_date, tz, lang, model_name, model,
          status, generation, dry_run)
       VALUES ($1, 'DAILY', '2026-06-11'::date, $2, 'KOREAN', 'openai', 'gpt-4o',
               'queued', 3, FALSE)`,
      [CUSTOMER_ID, TZ],
    );

    const res = await enqueueOnDemandReportJob(
      authPool,
      VARIANT({ bucketDate: "2026-06-11" }),
    );

    expect(res).toEqual({
      action: "coalesced",
      generation: 3,
      status: "queued",
    });
  });

  it("on-demand: coalesces onto a done job (cached result reused)", async () => {
    await seedState(authPool, "DAILY", "2026-06-12", "ready");
    await authPool.query(
      `INSERT INTO periodic_report_job
         (customer_id, period, bucket_date, tz, lang, model_name, model,
          status, generation, dry_run)
       VALUES ($1, 'DAILY', '2026-06-12'::date, $2, 'KOREAN', 'openai', 'gpt-4o',
               'done', 2, FALSE)`,
      [CUSTOMER_ID, TZ],
    );

    const res = await enqueueOnDemandReportJob(
      authPool,
      VARIANT({ bucketDate: "2026-06-12" }),
    );

    expect(res).toEqual({ action: "coalesced", generation: 2, status: "done" });
  });

  it("on-demand: re-queues a failed variant at the same generation", async () => {
    await seedState(authPool, "DAILY", "2026-06-13", "ready");
    await authPool.query(
      `INSERT INTO periodic_report_job
         (customer_id, period, bucket_date, tz, lang, model_name, model,
          status, generation, dry_run, attempts, last_error)
       VALUES ($1, 'DAILY', '2026-06-13'::date, $2, 'KOREAN', 'openai', 'gpt-4o',
               'failed', 4, FALSE, 5, 'aimer_4xx')`,
      [CUSTOMER_ID, TZ],
    );

    const res = await enqueueOnDemandReportJob(
      authPool,
      VARIANT({ bucketDate: "2026-06-13" }),
    );

    expect(res).toEqual({
      action: "requeued",
      generation: 4,
      status: "queued",
    });
    const { rows } = await authPool.query<{
      status: string;
      generation: number;
      attempts: number;
      last_error: string | null;
    }>(
      `SELECT status, generation, attempts, last_error FROM periodic_report_job
        WHERE customer_id = $1 AND period = 'DAILY'
          AND bucket_date = '2026-06-13'::date AND tz = $2 AND lang = 'KOREAN'`,
      [CUSTOMER_ID, TZ],
    );
    expect(rows[0]).toMatchObject({
      status: "queued",
      generation: 4,
      attempts: 0,
      last_error: null,
    });
  });

  it("on-demand: re-queues and activates a leftover dry-run row", async () => {
    await seedState(authPool, "DAILY", "2026-06-14", "ready");
    await authPool.query(
      `INSERT INTO periodic_report_job
         (customer_id, period, bucket_date, tz, lang, model_name, model,
          status, generation, dry_run)
       VALUES ($1, 'DAILY', '2026-06-14'::date, $2, 'KOREAN', 'openai', 'gpt-4o',
               'queued', 1, TRUE)`,
      [CUSTOMER_ID, TZ],
    );

    const res = await enqueueOnDemandReportJob(
      authPool,
      VARIANT({ bucketDate: "2026-06-14" }),
    );

    expect(res.action).toBe("requeued");
    const { rows } = await authPool.query<{ dry_run: boolean; status: string }>(
      `SELECT dry_run, status FROM periodic_report_job
        WHERE customer_id = $1 AND period = 'DAILY'
          AND bucket_date = '2026-06-14'::date AND tz = $2 AND lang = 'KOREAN'`,
      [CUSTOMER_ID, TZ],
    );
    expect(rows[0]).toEqual({ dry_run: false, status: "queued" });
  });

  it("on-demand: reports state_not_found when the parent state is absent", async () => {
    const res = await enqueueOnDemandReportJob(
      authPool,
      VARIANT({ bucketDate: "2026-06-15" }),
    );
    expect(res).toEqual({ action: "state_not_found" });
  });

  it("on-demand: reports source_pending for a pending parent (no job created)", async () => {
    await seedState(authPool, "DAILY", "2026-06-17", "pending");
    const res = await enqueueOnDemandReportJob(
      authPool,
      VARIANT({ bucketDate: "2026-06-17" }),
    );
    expect(res).toEqual({ action: "source_pending" });
    // A pending bucket must not start generation: the pickup query only
    // excludes `archived`, so a queued job here would reach the LLM before
    // the bucket's normal readiness promotion.
    const jobs = await jobsForBucket(authPool, "DAILY", "2026-06-17");
    expect(jobs).toHaveLength(0);
  });

  it("on-demand: reports source_unavailable for an archived parent", async () => {
    await seedState(authPool, "DAILY", "2026-06-16", "archived");
    const res = await enqueueOnDemandReportJob(
      authPool,
      VARIANT({ bucketDate: "2026-06-16" }),
    );
    expect(res).toEqual({ action: "source_unavailable" });
    // No job row created for the terminal state.
    const jobs = await jobsForBucket(authPool, "DAILY", "2026-06-16");
    expect(jobs).toHaveLength(0);
  });
});
