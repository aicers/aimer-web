// RFC 0002 Phase 0 (#326) — deterministic acceptance suite for the
// Phase 0 state-machine transitions.
//
// PR #325 amends the Phase 0 verification gate to accept either
// (a) 48h real-environment observation or (b) a deterministic
// acceptance suite. This file implements path (b): each scenario seeds
// fixtures, advances the mocked clock, runs `runAnalysisJobTickOnce`,
// and asserts the post-tick auth-DB state via SQL.
//
// The clock is mocked through `@/lib/instrumentation/time` —
// `getCurrentTimestamp()` returns a controllable `Date` so the worker
// SQL predicates (which now consume `$n::timestamptz` bind parameters
// instead of inline `NOW()`) become fully deterministic. For
// "events ingested N minutes ago" fixtures, source timestamps
// (`first_member_at`, `last_member_at`, `updated_at`, `received_at`,
// ...) are stamped as `mockNow - N` in JS rather than via SQL `NOW()`.
//
// Scenarios in scope: 1, 2, 3, 4, 5, 6a, 6b, 6c, 7, 8, 10a, 10b, 11a,
// 11b, 11c, 12. Scenario 9 is added by #297.

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

// Controllable clock — every call to `getCurrentTimestamp` inside the
// worker resolves through this hoisted helper. Tests call `setClock` to
// pin the tick's "now" deterministically. `vi.hoisted` runs before the
// `vi.mock` factory so the factory closes over the live state.
const clockSeam = vi.hoisted(() => {
  let current = new Date("2026-05-28T12:00:00.000Z");
  return {
    setClock: (d: Date) => {
      current = d;
    },
    get: () => new Date(current),
  };
});

vi.mock("@/lib/instrumentation/time", () => ({
  getCurrentTimestamp: () => clockSeam.get(),
}));
vi.mock("server-only", () => ({}));

const { runAnalysisJobTickOnce } = await import(
  "@/lib/instrumentation/analysis-job-worker"
);
const {
  dirtyPeriodicStatesOverlapping,
  recordBaselineActivity,
  recordStoryMemberArrival,
  LIVE_BUCKET_DATE,
} = await import("@/lib/analysis/state");
const { applyWindowReplaceStoryHook } = await import(
  "@/lib/analysis/ingest-hooks"
);
const { reconcileCustomer } = await import("@/lib/analysis/reconcile");
const { MAX_GENERATION } = await import("@/lib/analysis/story-worker");

const AUTH_MIGRATIONS_DIR = join(process.cwd(), "migrations", "auth");
const CUSTOMER_MIGRATIONS_DIR = join(process.cwd(), "migrations", "customer");
const AUTH_LOCK_ID = 3261;
const CUSTOMER_LOCK_ID = 3262;

const DEFAULT_LANG = "ENGLISH";
const DEFAULT_MODEL_NAME = "openai";
const DEFAULT_MODEL = "gpt-4o";

const MOCK_NOW = new Date("2026-05-28T12:00:00.000Z");

function minutesBefore(base: Date, minutes: number): Date {
  return new Date(base.getTime() - minutes * 60_000);
}
function hoursBefore(base: Date, hours: number): Date {
  return new Date(base.getTime() - hours * 3_600_000);
}

// `vi.spyOn(console, ...)` does not intercept structured `console.info`/
// `console.warn` calls reliably under this vitest config; install a
// direct console-method override that records arguments and restores
// the original on teardown.
function captureConsole(method: "info" | "warn"): {
  calls: unknown[][];
  restore: () => void;
} {
  const original = console[method];
  const calls: unknown[][] = [];
  console[method] = (...args: unknown[]) => {
    calls.push(args);
  };
  return {
    calls,
    restore: () => {
      console[method] = original;
    },
  };
}

// Decode each captured `console.*(JSON.stringify(...))` call back into a
// structured payload, skipping non-JSON entries. Each call site keeps its
// own `.filter(predicate)` to spell out the event and fields it asserts on.
function parseStructuredLogs(calls: unknown[][]): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const call of calls) {
    try {
      const parsed = JSON.parse(String(call[0]));
      if (parsed !== null && typeof parsed === "object") {
        out.push(parsed as Record<string, unknown>);
      }
    } catch {
      // structured-log assertions ignore non-JSON console output
    }
  }
  return out;
}

async function seedCustomer(
  pool: Pool,
  id: string,
  externalKey: string,
  timezone = "Asia/Seoul",
): Promise<void> {
  await pool.query(
    `INSERT INTO customers (id, external_key, name, database_status, timezone)
     VALUES ($1, $2, $2, 'active', $3)
     ON CONFLICT (id) DO UPDATE SET database_status = 'active'`,
    [id, externalKey, timezone],
  );
}

interface StoryStateSeed {
  status: "pending" | "ready" | "dirty";
  firstMemberAt?: Date | null;
  lastMemberAt?: Date | null;
  lastReadyAt?: Date | null;
  updatedAt?: Date;
}

async function seedStoryState(
  pool: Pool,
  customerId: string,
  storyId: string,
  seed: StoryStateSeed,
): Promise<void> {
  await pool.query(
    `INSERT INTO story_analysis_state
       (customer_id, story_id, status,
        first_member_at, last_member_at, last_ready_at,
        created_at, updated_at)
     VALUES ($1, $2::bigint, $3, $4, $5, $6, $7, $7)`,
    [
      customerId,
      storyId,
      seed.status,
      seed.firstMemberAt ?? null,
      seed.lastMemberAt ?? null,
      seed.lastReadyAt ?? null,
      (seed.updatedAt ?? MOCK_NOW).toISOString(),
    ],
  );
}

async function seedStoryJob(
  pool: Pool,
  customerId: string,
  storyId: string,
  opts: {
    status?: "queued" | "processing" | "done" | "failed";
    generation?: number;
    lastGeneratedAt?: Date | null;
    dryRun?: boolean;
    attempts?: number;
  } = {},
): Promise<void> {
  const status = opts.status ?? "done";
  await pool.query(
    `INSERT INTO story_analysis_job
       (customer_id, story_id, lang, model_name, model,
        status, generation, dry_run, attempts,
        processing_started_at, last_generated_at)
     VALUES ($1, $2::bigint, $3, $4, $5,
             $6, $7, $9, $10,
             $8, $8)`,
    [
      customerId,
      storyId,
      DEFAULT_LANG,
      DEFAULT_MODEL_NAME,
      DEFAULT_MODEL,
      status,
      opts.generation ?? 1,
      opts.lastGeneratedAt ? opts.lastGeneratedAt.toISOString() : null,
      opts.dryRun ?? true,
      opts.attempts ?? 0,
    ],
  );
}

interface PeriodicStateSeed {
  period: "LIVE" | "DAILY" | "WEEKLY" | "MONTHLY";
  bucketDate: string;
  tz: string;
  status: "pending" | "ready" | "dirty";
  updatedAt?: Date;
  lastEventAt?: Date | null;
  lastEventReceivedAt?: Date | null;
  lastReadyAt?: Date | null;
  cursorWatermark?: Date | null;
  cursorWatermarkQuality?: "strict" | "soft" | null;
}

async function seedPeriodicState(
  pool: Pool,
  customerId: string,
  seed: PeriodicStateSeed,
): Promise<void> {
  await pool.query(
    `INSERT INTO periodic_report_state
       (subject_id, period, bucket_date, tz, status,
        last_event_at, last_event_received_at, last_ready_at,
        cursor_watermark, cursor_watermark_quality,
        created_at, updated_at)
     VALUES ($1, $2, $3::date, $4, $5,
             $6, $7, $8,
             $9, $10,
             $11, $11)`,
    [
      customerId,
      seed.period,
      seed.bucketDate,
      seed.tz,
      seed.status,
      seed.lastEventAt ?? null,
      seed.lastEventReceivedAt ?? null,
      seed.lastReadyAt ?? null,
      seed.cursorWatermark ?? null,
      seed.cursorWatermarkQuality ?? null,
      (seed.updatedAt ?? MOCK_NOW).toISOString(),
    ],
  );
}

async function seedPeriodicJob(
  pool: Pool,
  customerId: string,
  seed: { period: string; bucketDate: string; tz: string; generation?: number },
): Promise<void> {
  await pool.query(
    `INSERT INTO periodic_report_job
       (subject_id, period, bucket_date, tz,
        lang, model_name, model,
        status, generation, dry_run,
        processing_started_at, last_generated_at)
     VALUES ($1, $2, $3::date, $4,
             $5, $6, $7,
             'done', $8, TRUE,
             $9, $9)`,
    [
      customerId,
      seed.period,
      seed.bucketDate,
      seed.tz,
      DEFAULT_LANG,
      DEFAULT_MODEL_NAME,
      DEFAULT_MODEL,
      seed.generation ?? 1,
      MOCK_NOW.toISOString(),
    ],
  );
}

async function getStoryState(pool: Pool, customerId: string, storyId: string) {
  const { rows } = await pool.query<{
    status: string;
    first_member_at: Date | null;
    last_member_at: Date | null;
    last_ready_at: Date | null;
  }>(
    `SELECT status, first_member_at, last_member_at, last_ready_at
       FROM story_analysis_state
      WHERE customer_id = $1 AND story_id = $2::bigint`,
    [customerId, storyId],
  );
  return rows[0] ?? null;
}

async function getStoryJob(pool: Pool, customerId: string, storyId: string) {
  const { rows } = await pool.query<{
    status: string;
    generation: number;
    dry_run: boolean;
    attempts: number;
    last_generated_at: Date | null;
  }>(
    `SELECT status, generation, dry_run, attempts, last_generated_at
       FROM story_analysis_job
      WHERE customer_id = $1 AND story_id = $2::bigint
        AND lang = $3 AND model_name = $4 AND model = $5`,
    [customerId, storyId, DEFAULT_LANG, DEFAULT_MODEL_NAME, DEFAULT_MODEL],
  );
  return rows[0] ?? null;
}

async function getPeriodicState(
  pool: Pool,
  customerId: string,
  period: string,
  bucketDate: string,
  tz: string,
) {
  const { rows } = await pool.query<{
    status: string;
    last_ready_at: Date | null;
  }>(
    `SELECT status, last_ready_at
       FROM periodic_report_state
      WHERE subject_id = $1 AND period = $2
        AND bucket_date = $3::date AND tz = $4`,
    [customerId, period, bucketDate, tz],
  );
  return rows[0] ?? null;
}

async function getPeriodicJob(
  pool: Pool,
  customerId: string,
  period: string,
  bucketDate: string,
  tz: string,
) {
  const { rows } = await pool.query<{
    status: string;
    generation: number;
    dry_run: boolean;
  }>(
    `SELECT status, generation, dry_run
       FROM periodic_report_job
      WHERE subject_id = $1 AND period = $2
        AND bucket_date = $3::date AND tz = $4
        AND lang = $5 AND model_name = $6 AND model = $7`,
    [
      customerId,
      period,
      bucketDate,
      tz,
      DEFAULT_LANG,
      DEFAULT_MODEL_NAME,
      DEFAULT_MODEL,
    ],
  );
  return rows[0] ?? null;
}

describe.skipIf(!hasPostgres)("Phase 0 acceptance suite", () => {
  let authDbName: string;
  let authPool: Pool;
  let customerDbName: string;
  let customerPool: Pool;

  beforeAll(async () => {
    const auth = await createTestDatabase("phase0_accept_auth");
    authDbName = auth.dbName;
    authPool = auth.pool;
    await runMigrations(authPool, AUTH_MIGRATIONS_DIR, AUTH_LOCK_ID);

    const cust = await createTestDatabase("phase0_accept_cust");
    customerDbName = cust.dbName;
    customerPool = cust.pool;
    await runMigrations(
      customerPool,
      CUSTOMER_MIGRATIONS_DIR,
      CUSTOMER_LOCK_ID,
    );

    // Reset clock before each test by re-pinning in `beforeEach` would be
    // overkill — every scenario sets its own clock first via `setClock`
    // and seeds with derived timestamps. Pin a stable default here.
    clockSeam.setClock(MOCK_NOW);
  });

  afterAll(async () => {
    await dropTestDatabase(authDbName, authPool);
    await dropTestDatabase(customerDbName, customerPool);
    await closeAdminPool();
  });

  // -------------------------------------------------------------------------
  // Scenario 1 — Story idle → ready
  // -------------------------------------------------------------------------
  it("scenario 1: story idle window elapses (16 minutes since last member) → ready", async () => {
    const customerId = "00000000-0000-0000-0000-000000000101";
    await seedCustomer(authPool, customerId, "s1");
    clockSeam.setClock(MOCK_NOW);

    // 3 members, last received 16 minutes ago. `first_member_at` is the
    // first arrival (16 minutes ago in this minimal fixture); the test
    // stamps both to the same source instant so the idle-window
    // (15-minute default) is the rule that fires, not the 6-hour max-
    // wait rule.
    const lastMemberAt = minutesBefore(MOCK_NOW, 16);
    await seedStoryState(authPool, customerId, "101", {
      status: "pending",
      firstMemberAt: lastMemberAt,
      lastMemberAt,
    });

    await runAnalysisJobTickOnce(authPool);

    const state = await getStoryState(authPool, customerId, "101");
    expect(state?.status).toBe("ready");
    expect(state?.last_ready_at?.toISOString()).toBe(MOCK_NOW.toISOString());
    // Phase 1 (#296): the tick seeds a real (non-dry-run) queued job
    // for the default variant. The LLM dispatch pass in the same tick
    // attempts to process it but fails to resolve a customer pool in
    // this test env (no CUSTOMER_DATABASE_URL); the failure is swallowed
    // by `tickStoryJobsOnce`, so the job remains queued.
    const job = await getStoryJob(authPool, customerId, "101");
    expect(job?.status).toBe("queued");
    expect(job?.dry_run).toBe(false);
    expect(job?.generation).toBe(1);
    expect(job?.last_generated_at).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Scenario 2 — Story max-wait → ready
  // -------------------------------------------------------------------------
  it("scenario 2: max-wait rule (6h+1min since first member) wins over still-active idle window → ready", async () => {
    const customerId = "00000000-0000-0000-0000-000000000102";
    await seedCustomer(authPool, customerId, "s2");
    clockSeam.setClock(MOCK_NOW);

    // Members trickling: latest 5 minutes ago (idle window NOT elapsed)
    // but `first_member_at` is 6h+1min ago so the max-wait rule fires.
    const firstMemberAt = new Date(MOCK_NOW.getTime() - (6 * 60 + 1) * 60_000);
    const lastMemberAt = minutesBefore(MOCK_NOW, 5);
    await seedStoryState(authPool, customerId, "102", {
      status: "pending",
      firstMemberAt,
      lastMemberAt,
    });

    await runAnalysisJobTickOnce(authPool);

    const state = await getStoryState(authPool, customerId, "102");
    expect(state?.status).toBe("ready");
  });

  // -------------------------------------------------------------------------
  // Scenario 3 — Story dirty cascade
  // -------------------------------------------------------------------------
  it("scenario 3: late member after ready+done flips state to dirty; worker tick advances generation and re-marks job done", async () => {
    const customerId = "00000000-0000-0000-0000-000000000103";
    await seedCustomer(authPool, customerId, "s3");
    clockSeam.setClock(MOCK_NOW);

    const firstMemberAt = minutesBefore(MOCK_NOW, 60);
    const lastMemberAt = minutesBefore(MOCK_NOW, 30);
    await seedStoryState(authPool, customerId, "103", {
      status: "ready",
      firstMemberAt,
      lastMemberAt,
      lastReadyAt: minutesBefore(MOCK_NOW, 25),
    });
    await seedStoryJob(authPool, customerId, "103", {
      status: "done",
      generation: 1,
      lastGeneratedAt: minutesBefore(MOCK_NOW, 25),
    });

    // Ingest hook: late member arrival flips state to dirty.
    const arrival = MOCK_NOW;
    const client = await authPool.connect();
    try {
      await recordStoryMemberArrival(client, customerId, "103", arrival);
    } finally {
      client.release();
    }
    const dirty = await getStoryState(authPool, customerId, "103");
    expect(dirty?.status).toBe("dirty");

    await runAnalysisJobTickOnce(authPool);

    // Phase 1 (#296): dirty re-queues bump the existing job to a fresh
    // queued generation with `dry_run=FALSE` and `attempts=0`. The LLM
    // dispatch pass attempts to run but the test env lacks a customer
    // pool, so the job stays queued at generation=2.
    const job = await getStoryJob(authPool, customerId, "103");
    expect(job?.status).toBe("queued");
    expect(job?.dry_run).toBe(false);
    expect(job?.generation).toBe(2);

    const post = await getStoryState(authPool, customerId, "103");
    expect(post?.status).toBe("ready");
    expect(post?.last_ready_at?.toISOString()).toBe(MOCK_NOW.toISOString());
  });

  // -------------------------------------------------------------------------
  // Scenario 4 — Periodic refresh-window overlap → dirty
  // -------------------------------------------------------------------------
  it("scenario 4: refresh-window envelope overlapping a ready/done DAILY bucket → dirty", async () => {
    const customerId = "00000000-0000-0000-0000-000000000104";
    await seedCustomer(authPool, customerId, "s4");
    clockSeam.setClock(MOCK_NOW);

    const tz = "Asia/Seoul";
    const bucketDate = "2026-05-20"; // KST window [05-20 00:00 KST, 05-21 00:00 KST).
    await seedPeriodicState(authPool, customerId, {
      period: "DAILY",
      bucketDate,
      tz,
      status: "ready",
      lastReadyAt: MOCK_NOW,
      updatedAt: minutesBefore(MOCK_NOW, 60),
    });
    await seedPeriodicJob(authPool, customerId, {
      period: "DAILY",
      bucketDate,
      tz,
    });

    // Envelope spans 2026-05-20 03:00Z..2026-05-20 09:00Z (= 12:00..
    // 18:00 KST), which sits inside the DAILY 2026-05-20 KST window.
    const client = await authPool.connect();
    try {
      await dirtyPeriodicStatesOverlapping(
        client,
        customerId,
        new Date("2026-05-20T03:00:00Z"),
        new Date("2026-05-20T09:00:00Z"),
      );
    } finally {
      client.release();
    }

    const state = await getPeriodicState(
      authPool,
      customerId,
      "DAILY",
      bucketDate,
      tz,
    );
    expect(state?.status).toBe("dirty");
  });

  // -------------------------------------------------------------------------
  // Scenario 5 — Regular Phase 2 batch dirtying a done bucket
  // -------------------------------------------------------------------------
  it("scenario 5: recordBaselineActivity with event_time inside a ready/done DAILY bucket → dirty", async () => {
    const customerId = "00000000-0000-0000-0000-000000000105";
    await seedCustomer(authPool, customerId, "s5");
    clockSeam.setClock(MOCK_NOW);

    const tz = "Asia/Seoul";
    // 2024-03-10 03:00 UTC = 2024-03-10 12:00 KST → DAILY 2024-03-10.
    // This event_time is historical — outside the trailing-24h LIVE
    // window — so the LIVE branch is a no-op and we directly observe
    // the DAILY dirty transition.
    const bucketDate = "2024-03-10";
    const eventTime = new Date("2024-03-10T03:00:00Z");
    await seedPeriodicState(authPool, customerId, {
      period: "DAILY",
      bucketDate,
      tz,
      status: "ready",
      lastReadyAt: MOCK_NOW,
      updatedAt: minutesBefore(MOCK_NOW, 90),
    });
    await seedPeriodicJob(authPool, customerId, {
      period: "DAILY",
      bucketDate,
      tz,
    });

    const client = await authPool.connect();
    try {
      await recordBaselineActivity(client, customerId, tz, [
        { eventTime, receivedAt: eventTime },
      ]);
    } finally {
      client.release();
    }

    const state = await getPeriodicState(
      authPool,
      customerId,
      "DAILY",
      bucketDate,
      tz,
    );
    expect(state?.status).toBe("dirty");
  });

  // -------------------------------------------------------------------------
  // Scenario 6a — DAILY settle → ready
  // -------------------------------------------------------------------------
  it("scenario 6a: DAILY bucket end was 3h+1min ago and no recent ingest activity → ready", async () => {
    const customerId = "00000000-0000-0000-0000-000000000106";
    await seedCustomer(authPool, customerId, "s6a");

    const tz = "Asia/Seoul";
    // DAILY 2026-05-20 KST closes at 2026-05-21 00:00 KST =
    // 2026-05-20 15:00 UTC. Pin mockNow to 18:01 UTC so the bucket end
    // was exactly 3h+1min ago, satisfying the 3h DAILY settle window.
    const mockNow = new Date("2026-05-20T18:01:00.000Z");
    clockSeam.setClock(mockNow);
    const bucketDate = "2026-05-20";
    await seedPeriodicState(authPool, customerId, {
      period: "DAILY",
      bucketDate,
      tz,
      status: "pending",
      // `updated_at` is well past the 30-minute quiet window so the
      // quiet-window gate does not hold the row in pending.
      updatedAt: hoursBefore(mockNow, 2),
    });

    await runAnalysisJobTickOnce(authPool);

    const state = await getPeriodicState(
      authPool,
      customerId,
      "DAILY",
      bucketDate,
      tz,
    );
    expect(state?.status).toBe("ready");
    expect(state?.last_ready_at?.toISOString()).toBe(mockNow.toISOString());
  });

  // -------------------------------------------------------------------------
  // Scenario 6b — DAILY with strict watermark (shortened 1h settle) → ready
  // -------------------------------------------------------------------------
  it("scenario 6b: DAILY bucket end was 1h+1min ago and a strict cursor watermark covers the bucket → ready with shortened-settle log", async () => {
    const customerId = "00000000-0000-0000-0000-000000000206";
    await seedCustomer(authPool, customerId, "s6b");

    const tz = "Asia/Seoul";
    // DAILY 2026-05-20 KST closes at 2026-05-21 00:00 KST =
    // 2026-05-20 15:00 UTC. Pin mockNow to 16:01 UTC so the bucket end
    // was 1h+1min ago — the shortened (1h) settle has elapsed but the
    // baseline (3h) settle has not.
    const mockNow = new Date("2026-05-20T16:01:00.000Z");
    clockSeam.setClock(mockNow);
    const bucketDate = "2026-05-20";
    const bucketEnd = new Date("2026-05-20T15:00:00.000Z");
    // Watermark just past the bucket end satisfies the
    // `cursor_watermark >= bucket_end` predicate.
    const watermark = new Date(bucketEnd.getTime() + 1_000);
    await seedPeriodicState(authPool, customerId, {
      period: "DAILY",
      bucketDate,
      tz,
      status: "pending",
      updatedAt: hoursBefore(mockNow, 2),
      lastEventAt: hoursBefore(mockNow, 2),
      cursorWatermark: watermark,
      cursorWatermarkQuality: "strict",
    });

    const infoCapture = captureConsole("info");
    try {
      await runAnalysisJobTickOnce(authPool);
    } finally {
      infoCapture.restore();
    }

    const state = await getPeriodicState(
      authPool,
      customerId,
      "DAILY",
      bucketDate,
      tz,
    );
    expect(state?.status).toBe("ready");
    expect(state?.last_ready_at?.toISOString()).toBe(mockNow.toISOString());

    const shortenedLogs = parseStructuredLogs(infoCapture.calls).filter(
      (
        payload,
      ): payload is {
        level: string;
        event: string;
        customer_id: string;
        period: string;
        bucket_date: string;
        tz: string;
        cursor_watermark: string;
        bucket_end_at: string;
      } =>
        payload.event === "analysis.daily_settle_shortened" &&
        payload.customer_id === customerId,
    );
    expect(shortenedLogs).toHaveLength(1);
    const log = shortenedLogs[0];
    expect(log.level).toBe("info");
    expect(log.period).toBe("DAILY");
    expect(log.bucket_date).toBe(bucketDate);
    expect(log.tz).toBe(tz);
    expect(new Date(log.cursor_watermark).toISOString()).toBe(
      watermark.toISOString(),
    );
    expect(new Date(log.bucket_end_at).toISOString()).toBe(
      bucketEnd.toISOString(),
    );

    // Phase 2 (#297): the tick seeds a real (non-dry-run) queued job for
    // the newly-ready DAILY bucket. The LLM dispatch pass attempts to
    // process it but fails to resolve a customer pool in this test env
    // (no CUSTOMER_DATABASE_URL), so the job stays queued at generation 1.
    const job = await getPeriodicJob(
      authPool,
      customerId,
      "DAILY",
      bucketDate,
      tz,
    );
    expect(job?.status).toBe("queued");
    expect(job?.dry_run).toBe(false);
    expect(job?.generation).toBe(1);
  });

  // -------------------------------------------------------------------------
  // Scenario 6c — DAILY not-yet-settled (negative case) → stays pending
  // -------------------------------------------------------------------------
  it("scenario 6c: DAILY bucket end 30min ago with soft watermark → stays pending (neither shortened nor baseline settle elapsed)", async () => {
    const customerId = "00000000-0000-0000-0000-000000000306";
    await seedCustomer(authPool, customerId, "s6c");

    const tz = "Asia/Seoul";
    // Same bucket as 6b. Pin mockNow to 15:30 UTC so the bucket end was
    // only 30 minutes ago — neither the 1h shortened nor the 3h baseline
    // settle has elapsed. With a soft watermark the shortened branch is
    // ineligible regardless.
    const mockNow = new Date("2026-05-20T15:30:00.000Z");
    clockSeam.setClock(mockNow);
    const bucketDate = "2026-05-20";
    const bucketEnd = new Date("2026-05-20T15:00:00.000Z");
    const watermark = new Date(bucketEnd.getTime() + 1_000);
    await seedPeriodicState(authPool, customerId, {
      period: "DAILY",
      bucketDate,
      tz,
      status: "pending",
      // 60-min-old `updated_at` clears the 30-min quiet window so the
      // quiet gate alone wouldn't hold the row in pending.
      updatedAt: minutesBefore(mockNow, 60),
      lastEventAt: minutesBefore(mockNow, 60),
      cursorWatermark: watermark,
      cursorWatermarkQuality: "soft",
    });

    const infoCapture = captureConsole("info");
    try {
      await runAnalysisJobTickOnce(authPool);
    } finally {
      infoCapture.restore();
    }

    const state = await getPeriodicState(
      authPool,
      customerId,
      "DAILY",
      bucketDate,
      tz,
    );
    expect(state?.status).toBe("pending");
    expect(state?.last_ready_at).toBeNull();

    const shortenedLogs = parseStructuredLogs(infoCapture.calls).filter(
      (payload): payload is { event: string; customer_id: string } =>
        payload.event === "analysis.daily_settle_shortened" &&
        payload.customer_id === customerId,
    );
    expect(shortenedLogs).toHaveLength(0);

    const job = await getPeriodicJob(
      authPool,
      customerId,
      "DAILY",
      bucketDate,
      tz,
    );
    expect(job).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Scenario 7 — WEEKLY settle → ready
  // -------------------------------------------------------------------------
  it("scenario 7: WEEKLY bucket end was 6h+1min ago, no recent ingest → ready", async () => {
    const customerId = "00000000-0000-0000-0000-000000000107";
    await seedCustomer(authPool, customerId, "s7");

    const tz = "Asia/Seoul";
    // WEEKLY bucket 2026-05-11 KST spans Monday 2026-05-11 00:00 KST..
    // Monday 2026-05-18 00:00 KST. Bucket end in UTC =
    // 2026-05-17 15:00 UTC. Pin mockNow to 21:01 UTC so the bucket
    // closed 6h+1min ago (clears the 6h WEEKLY settle window).
    const mockNow = new Date("2026-05-17T21:01:00.000Z");
    clockSeam.setClock(mockNow);
    const bucketDate = "2026-05-11";
    await seedPeriodicState(authPool, customerId, {
      period: "WEEKLY",
      bucketDate,
      tz,
      status: "pending",
      updatedAt: hoursBefore(mockNow, 2),
    });

    await runAnalysisJobTickOnce(authPool);

    const state = await getPeriodicState(
      authPool,
      customerId,
      "WEEKLY",
      bucketDate,
      tz,
    );
    expect(state?.status).toBe("ready");
  });

  // -------------------------------------------------------------------------
  // Scenario 8 — MONTHLY settle → ready
  // -------------------------------------------------------------------------
  it("scenario 8: MONTHLY bucket end was 12h+1min ago, no recent ingest → ready", async () => {
    const customerId = "00000000-0000-0000-0000-000000000108";
    await seedCustomer(authPool, customerId, "s8");

    const tz = "Asia/Seoul";
    // MONTHLY 2026-04-01 KST spans 2026-04-01 00:00 KST..2026-05-01
    // 00:00 KST. Bucket end in UTC = 2026-04-30 15:00 UTC. Pin mockNow
    // to 2026-05-01 03:01 UTC so the bucket end was 12h+1min ago,
    // clearing the 12h MONTHLY settle window.
    const mockNow = new Date("2026-05-01T03:01:00.000Z");
    clockSeam.setClock(mockNow);
    const bucketDate = "2026-04-01";
    await seedPeriodicState(authPool, customerId, {
      period: "MONTHLY",
      bucketDate,
      tz,
      status: "pending",
      updatedAt: hoursBefore(mockNow, 2),
    });

    await runAnalysisJobTickOnce(authPool);

    const state = await getPeriodicState(
      authPool,
      customerId,
      "MONTHLY",
      bucketDate,
      tz,
    );
    expect(state?.status).toBe("ready");
  });

  // -------------------------------------------------------------------------
  // Scenario 9 — LIVE next_due_at cadence re-queue (#297)
  // -------------------------------------------------------------------------
  it("scenario 9: a done LIVE variant whose next_due_at elapsed is re-queued (generation++) on the next tick", async () => {
    const customerId = "00000000-0000-0000-0000-000000000109";
    await seedCustomer(authPool, customerId, "s9");
    const mockNow = new Date("2026-05-20T12:00:00.000Z");
    clockSeam.setClock(mockNow);

    const tz = "Asia/Seoul";
    // LIVE rows use the synthetic bucket date and a non-archived state.
    await seedPeriodicState(authPool, customerId, {
      period: "LIVE",
      bucketDate: LIVE_BUCKET_DATE,
      tz,
      status: "ready",
      lastReadyAt: hoursBefore(mockNow, 2),
      updatedAt: hoursBefore(mockNow, 2),
    });
    // A real (non-dry-run) LIVE job at `done` whose cadence elapsed:
    // next_due_at is 1 minute in the past.
    await authPool.query(
      `INSERT INTO periodic_report_job
         (subject_id, period, bucket_date, tz, lang, model_name, model,
          status, generation, dry_run,
          last_generated_at, next_due_at)
       VALUES ($1, 'LIVE', $2::date, $3, $4, $5, $6,
               'done', 1, FALSE,
               $7::timestamptz, $8::timestamptz)`,
      [
        customerId,
        LIVE_BUCKET_DATE,
        tz,
        DEFAULT_LANG,
        DEFAULT_MODEL_NAME,
        DEFAULT_MODEL,
        hoursBefore(mockNow, 1).toISOString(),
        minutesBefore(mockNow, 1).toISOString(),
      ],
    );

    await runAnalysisJobTickOnce(authPool);

    // The cadence re-queue bumps the job to generation 2, status queued.
    // The LLM dispatch pass attempts it but cannot resolve a customer
    // pool in this env, so it stays queued.
    const job = await getPeriodicJob(
      authPool,
      customerId,
      "LIVE",
      LIVE_BUCKET_DATE,
      tz,
    );
    expect(job?.status).toBe("queued");
    expect(job?.dry_run).toBe(false);
    expect(job?.generation).toBe(2);
  });

  // -------------------------------------------------------------------------
  // Scenario 10 — Archived → re-pending cycle
  // -------------------------------------------------------------------------
  it("scenario 10a: window-replace removing every story_version archives the state; default-variant jobs survive", async () => {
    const customerId = "00000000-0000-0000-0000-00000000010a";
    await seedCustomer(authPool, customerId, "s10a");
    clockSeam.setClock(MOCK_NOW);

    await seedStoryState(authPool, customerId, "1010", {
      status: "ready",
      firstMemberAt: minutesBefore(MOCK_NOW, 90),
      lastMemberAt: minutesBefore(MOCK_NOW, 60),
      lastReadyAt: minutesBefore(MOCK_NOW, 45),
    });
    await seedStoryJob(authPool, customerId, "1010", {
      status: "done",
      generation: 1,
      lastGeneratedAt: minutesBefore(MOCK_NOW, 45),
    });

    // window-replace with surviving=0 archives the state row.
    await applyWindowReplaceStoryHook(authPool, {
      customerId,
      mutatedStoryIds: ["1010"],
      storyVersionSurvivors: [
        { storyId: "1010", surviving: 0, lastReceivedAt: null },
      ],
    });

    const state = await getStoryState(authPool, customerId, "1010");
    expect(state?.status).toBe("archived");
    // Decision 1: default-variant jobs survive — they belong to the
    // archived generation and are only deleted on the unarchive path
    // (scenario 10b) when the story_id re-appears.
    const job = await getStoryJob(authPool, customerId, "1010");
    expect(job).not.toBeNull();
  });

  it("scenario 10b: same story_id re-appearing via a later window-replace unarchives in place — pending status, cleared timestamps, prior jobs deleted", async () => {
    const customerId = "00000000-0000-0000-0000-00000000010b";
    await seedCustomer(authPool, customerId, "s10b");
    clockSeam.setClock(MOCK_NOW);

    // Pre-state: an archived row with a stale dry-run job from the
    // prior generation. Mirrors the post-10a shape.
    await seedStoryState(authPool, customerId, "1011", {
      status: "ready",
      firstMemberAt: minutesBefore(MOCK_NOW, 90),
      lastMemberAt: minutesBefore(MOCK_NOW, 60),
      lastReadyAt: minutesBefore(MOCK_NOW, 45),
    });
    await seedStoryJob(authPool, customerId, "1011", {
      status: "done",
      generation: 1,
      lastGeneratedAt: minutesBefore(MOCK_NOW, 45),
    });
    await applyWindowReplaceStoryHook(authPool, {
      customerId,
      mutatedStoryIds: ["1011"],
      storyVersionSurvivors: [
        { storyId: "1011", surviving: 0, lastReceivedAt: null },
      ],
    });
    expect((await getStoryState(authPool, customerId, "1011"))?.status).toBe(
      "archived",
    );

    // Re-insertion: same story_id appears in a later window-replace
    // with surviving>0.
    await applyWindowReplaceStoryHook(authPool, {
      customerId,
      mutatedStoryIds: ["1011"],
      storyVersionSurvivors: [
        {
          storyId: "1011",
          surviving: 1,
          lastReceivedAt: MOCK_NOW,
        },
      ],
    });

    const state = await getStoryState(authPool, customerId, "1011");
    expect(state?.status).toBe("pending");
    // Source timestamps + last_ready_at cleared per decision 1.
    expect(state?.first_member_at).toBeNull();
    expect(state?.last_member_at).toBeNull();
    expect(state?.last_ready_at).toBeNull();
    // Stale archived-run job deleted.
    const job = await getStoryJob(authPool, customerId, "1011");
    expect(job).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Scenario 11 — Reconciliation seed cleanliness
  // -------------------------------------------------------------------------
  it("scenario 11a: story row in customer DB with no auth-DB state row → reconcile seeds state row", async () => {
    const customerId = "00000000-0000-0000-0000-00000000011a";
    const tz = "Asia/Seoul";
    await seedCustomer(authPool, customerId, "s11a", tz);
    clockSeam.setClock(MOCK_NOW);

    // Customer DB story rows only — no auth-DB state row.
    await customerPool.query(
      `INSERT INTO story
         (story_id, story_version, kind,
          time_window_start, time_window_end,
          summary_payload, source_aice_id, received_at)
       VALUES (1111, 'v1', 'auto_correlated',
               $1::timestamptz, ($1::timestamptz + INTERVAL '5 minutes'),
               '{}'::jsonb, 'aice-1', $1::timestamptz)`,
      [minutesBefore(MOCK_NOW, 30).toISOString()],
    );

    const outcome = await reconcileCustomer(customerId, tz, {
      authPool,
      connectCustomer: async () => {
        const client: PoolClient = await customerPool.connect();
        return {
          query: client.query.bind(client) as PoolClient["query"],
          end: async () => {
            client.release();
          },
        };
      },
    });
    expect(outcome.status).toBe("completed");
    expect(outcome.storyStatesSeeded).toBeGreaterThanOrEqual(1);

    const state = await getStoryState(authPool, customerId, "1111");
    expect(state?.status).toBe("pending");
    expect(state?.first_member_at?.toISOString()).toBe(
      minutesBefore(MOCK_NOW, 30).toISOString(),
    );
  });

  it("scenario 11b: last_member_at lagging behind the latest story.received_at → reconcile forward-patches the column", async () => {
    const customerId = "00000000-0000-0000-0000-00000000011b";
    const tz = "Asia/Seoul";
    await seedCustomer(authPool, customerId, "s11b", tz);
    clockSeam.setClock(MOCK_NOW);

    // Auth-DB state row stamped against an older received_at.
    const stale = minutesBefore(MOCK_NOW, 60);
    const fresh = minutesBefore(MOCK_NOW, 10);
    await seedStoryState(authPool, customerId, "2222", {
      status: "pending",
      firstMemberAt: stale,
      lastMemberAt: stale,
    });
    // Customer DB now has a newer version.
    await customerPool.query(
      `INSERT INTO story
         (story_id, story_version, kind,
          time_window_start, time_window_end,
          summary_payload, source_aice_id, received_at)
       VALUES
         (2222, 'v1', 'auto_correlated',
          $1::timestamptz, ($1::timestamptz + INTERVAL '5 minutes'),
          '{}'::jsonb, 'aice-1', $1::timestamptz),
         (2222, 'v2', 'auto_correlated',
          $2::timestamptz, ($2::timestamptz + INTERVAL '5 minutes'),
          '{}'::jsonb, 'aice-1', $2::timestamptz)`,
      [stale.toISOString(), fresh.toISOString()],
    );

    const deps = {
      authPool,
      connectCustomer: async () => {
        const client: PoolClient = await customerPool.connect();
        return {
          query: client.query.bind(client) as PoolClient["query"],
          end: async () => {
            client.release();
          },
        };
      },
    };

    const outcome = await reconcileCustomer(customerId, tz, deps);
    expect(outcome.status).toBe("completed");
    expect(outcome.storyStatesPatched).toBeGreaterThanOrEqual(1);

    const state = await getStoryState(authPool, customerId, "2222");
    expect(state?.last_member_at?.toISOString()).toBe(fresh.toISOString());
  });

  it("scenario 11c: a second reconcile pass with no DB change in between is a no-op (zero seeds, zero patches)", async () => {
    const customerId = "00000000-0000-0000-0000-00000000011c";
    const tz = "Asia/Seoul";
    await seedCustomer(authPool, customerId, "s11c", tz);
    clockSeam.setClock(MOCK_NOW);

    await customerPool.query(
      `INSERT INTO story
         (story_id, story_version, kind,
          time_window_start, time_window_end,
          summary_payload, source_aice_id, received_at)
       VALUES (3333, 'v1', 'auto_correlated',
               $1::timestamptz, ($1::timestamptz + INTERVAL '5 minutes'),
               '{}'::jsonb, 'aice-1', $1::timestamptz)`,
      [minutesBefore(MOCK_NOW, 30).toISOString()],
    );

    const deps = {
      authPool,
      connectCustomer: async () => {
        const client: PoolClient = await customerPool.connect();
        return {
          query: client.query.bind(client) as PoolClient["query"],
          end: async () => {
            client.release();
          },
        };
      },
    };

    const first = await reconcileCustomer(customerId, tz, deps);
    expect(first.status).toBe("completed");
    expect(first.storyStatesSeeded).toBeGreaterThanOrEqual(1);

    const second = await reconcileCustomer(customerId, tz, deps);
    expect(second.status).toBe("completed");
    expect(second.storyStatesSeeded).toBe(0);
    expect(second.storyStatesPatched).toBe(0);
    expect(second.periodicStatesSeeded).toBe(0);
    expect(second.periodicStatesPatched).toBe(0);
  });

  // -------------------------------------------------------------------------
  // Scenario 12 — Generation cap on dirty re-queue (sub-case b)
  // -------------------------------------------------------------------------
  it("scenario 12: dirty re-queue at MAX_GENERATION does not bump the job and emits a warn log; state still cycles dirty → ready each tick", async () => {
    const customerId = "00000000-0000-0000-0000-000000000112";
    await seedCustomer(authPool, customerId, "s12");
    clockSeam.setClock(MOCK_NOW);

    const storyId = "1212";
    await seedStoryState(authPool, customerId, storyId, {
      status: "ready",
      firstMemberAt: hoursBefore(MOCK_NOW, 24),
      lastMemberAt: hoursBefore(MOCK_NOW, 12),
      lastReadyAt: minutesBefore(MOCK_NOW, 15),
    });
    await seedStoryJob(authPool, customerId, storyId, {
      status: "done",
      generation: MAX_GENERATION,
      dryRun: false,
      lastGeneratedAt: minutesBefore(MOCK_NOW, 15),
    });

    for (let cycle = 0; cycle < 3; cycle += 1) {
      const arrival = MOCK_NOW;
      const client = await authPool.connect();
      try {
        await recordStoryMemberArrival(client, customerId, storyId, arrival);
      } finally {
        client.release();
      }
      expect((await getStoryState(authPool, customerId, storyId))?.status).toBe(
        "dirty",
      );

      const warnCapture = captureConsole("warn");
      try {
        await runAnalysisJobTickOnce(authPool);
      } finally {
        warnCapture.restore();
      }

      const job = await getStoryJob(authPool, customerId, storyId);
      expect(job?.generation).toBe(MAX_GENERATION);
      expect(job?.status).toBe("done");
      expect(job?.dry_run).toBe(false);

      const capLogs = parseStructuredLogs(warnCapture.calls).filter(
        (
          payload,
        ): payload is {
          level: string;
          event: string;
          customer_id: string;
          story_id: string;
          max_generation: number;
        } =>
          payload.event === "analysis.story_max_generation_reached" &&
          payload.customer_id === customerId &&
          payload.story_id === storyId,
      );
      // Bilingual (#580): the dirty seeder pairs the missing user-language
      // translate variant at the canonical's generation. When the canonical is
      // already at MAX_GENERATION the translation is seeded at the cap too, so
      // from the next cycle on BOTH the English canonical and its translation
      // sit at MAX_GENERATION and the per-capped-variant warn fires once for
      // each (one warn on the first cycle, before the translation exists; two
      // thereafter). The invariant under test is that every capped variant
      // warns AT the cap and none auto-bumps — not a single fixed count.
      expect(capLogs.length).toBeGreaterThanOrEqual(1);
      for (const capLog of capLogs) {
        expect(capLog.level).toBe("warn");
        expect(capLog.max_generation).toBe(MAX_GENERATION);
      }

      const state = await getStoryState(authPool, customerId, storyId);
      expect(state?.status).toBe("ready");
    }
  });

  // Companion: sub-case (a) regression — a parallel fixture seeded at
  // MAX_GENERATION - 1 bumps to MAX_GENERATION on its first cycle with
  // no `story_max_generation_reached` log. Without this, scenario 12
  // cannot distinguish "cap fires correctly" from "every cycle silently
  // fails to bump".
  it("scenario 12 companion: dirty re-queue below MAX_GENERATION bumps the job to MAX_GENERATION (sub-case a regression)", async () => {
    const customerId = "00000000-0000-0000-0000-000000000212";
    await seedCustomer(authPool, customerId, "s12-a");
    clockSeam.setClock(MOCK_NOW);

    const storyId = "1213";
    await seedStoryState(authPool, customerId, storyId, {
      status: "ready",
      firstMemberAt: hoursBefore(MOCK_NOW, 24),
      lastMemberAt: hoursBefore(MOCK_NOW, 12),
      lastReadyAt: minutesBefore(MOCK_NOW, 15),
    });
    await seedStoryJob(authPool, customerId, storyId, {
      status: "done",
      generation: MAX_GENERATION - 1,
      dryRun: false,
      lastGeneratedAt: minutesBefore(MOCK_NOW, 15),
      // Seed a nonzero retry count so the test catches a regression
      // where the dirty-bump branch stops clearing `attempts`.
      attempts: 3,
    });

    const arrival = MOCK_NOW;
    const client = await authPool.connect();
    try {
      await recordStoryMemberArrival(client, customerId, storyId, arrival);
    } finally {
      client.release();
    }

    const warnCapture = captureConsole("warn");
    try {
      await runAnalysisJobTickOnce(authPool);
    } finally {
      warnCapture.restore();
    }

    // Same as scenario 3: the bump leaves the job at `status='queued',
    // dry_run=FALSE, attempts=0`. The LLM dispatch pass swallows the
    // customer-pool failure in the test env, so the job stays queued at
    // the bumped generation.
    const job = await getStoryJob(authPool, customerId, storyId);
    expect(job?.generation).toBe(MAX_GENERATION);
    expect(job?.status).toBe("queued");
    expect(job?.dry_run).toBe(false);
    expect(job?.attempts).toBe(0);

    const capLogs = parseStructuredLogs(warnCapture.calls).filter(
      (payload): payload is { event: string; customer_id: string } =>
        payload.event === "analysis.story_max_generation_reached" &&
        payload.customer_id === customerId,
    );
    expect(capLogs).toHaveLength(0);

    const state = await getStoryState(authPool, customerId, storyId);
    expect(state?.status).toBe("ready");
  });
});
