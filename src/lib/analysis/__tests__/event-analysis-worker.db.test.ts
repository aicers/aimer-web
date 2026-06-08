// #493 — individual baseline-event auto-analysis worker (cross-DB).
//
// Drives `seedBaselineEventJobs` + `processEventJob` against a real auth DB
// (event_analysis_job) and customer DB (event_enrichment_state,
// event_analysis_result, story/story_member), with the LLM analyze step and
// the IOC enrichment drive injected. Covers the acceptance criteria:
//   - story members are deduped out (never auto-analyzed),
//   - a live target-variant leaf suppresses re-seeding (rebaseline idem.),
//   - a tier-A IOC verdict is always analyzed; a non-IOC complete-coverage
//     miss is tier B (budget-gated),
//   - the tier-B cap is a SEED-TIME RESERVATION counting in-flight rows
//     (cap+N seeded with zero completions → exactly cap admitted, N skipped),
//   - tier-A volume does NOT consume the tier-B budget,
//   - cap = 0 disables tier B,
//   - an absent verdict is HELD (not classified) until a bounded enrichment
//     drive runs; a negative under non-complete coverage is held + re-checked,
//     upgraded to tier A on a flip, and falls back to tier B (never silently
//     budget_skipped) on bound exhaustion.

import { join } from "node:path";
import type { Pool, PoolClient } from "pg";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

vi.mock("server-only", () => ({}));

import {
  closeAdminPool,
  createTestDatabase,
  dropTestDatabase,
  hasPostgres,
} from "@/lib/db/__tests__/db-test-helpers";
import { runMigrations } from "@/lib/db/migrate";
import type { CoverageStatus } from "../enrichment/types";
import {
  type BaselineSeedCandidate,
  type ProcessEventJobOptions,
  processEventJob,
  seedBaselineEventJobs,
  tickEventJobsOnce,
} from "../event-analysis-worker";
import {
  loadEventEnrichmentVerdict,
  runEventEnrichment,
} from "../event-enrichment-worker";

const AUTH_MIGRATIONS_DIR = join(process.cwd(), "migrations", "auth");
const CUSTOMER_MIGRATIONS_DIR = join(process.cwd(), "migrations", "customer");
const AUTH_LOCK_ID = 2641;
const CUSTOMER_LOCK_ID = 2642;
const CUSTOMER_ID = "00000000-0000-0000-0000-0000000004d1";
const AICE_ID = "aice-1";
const LANG = "ENGLISH";
const MODEL_NAME = "openai";
const MODEL = "gpt-4o";
const NOW = "2026-06-04T12:00:00.000Z";

const MODEL_PAIR = { modelName: MODEL_NAME, model: MODEL };

describe.skipIf(!hasPostgres)("baseline event auto-analysis worker", () => {
  let authDbName: string;
  let authPool: Pool;
  let customerDbName: string;
  let customerPool: Pool;

  beforeAll(async () => {
    const auth = await createTestDatabase("evt_job_auth");
    authDbName = auth.dbName;
    authPool = auth.pool;
    await runMigrations(authPool, AUTH_MIGRATIONS_DIR, AUTH_LOCK_ID);

    const cust = await createTestDatabase("evt_job_cust");
    customerDbName = cust.dbName;
    customerPool = cust.pool;
    await runMigrations(
      customerPool,
      CUSTOMER_MIGRATIONS_DIR,
      CUSTOMER_LOCK_ID,
    );

    await authPool.query(
      `INSERT INTO customers (id, external_key, name, database_status, timezone)
       VALUES ($1, 'evt-job', 'Event Job', 'active', 'Asia/Seoul')`,
      [CUSTOMER_ID],
    );
  }, 60_000);

  afterAll(async () => {
    await dropTestDatabase(authDbName, authPool);
    await dropTestDatabase(customerDbName, customerPool);
    await closeAdminPool();
  }, 30_000);

  beforeEach(async () => {
    await authPool.query("DELETE FROM event_analysis_job");
    // periodic_report_job FK-references periodic_report_state (ON DELETE
    // CASCADE); delete the job side first so the order is explicit.
    await authPool.query("DELETE FROM periodic_report_job");
    await authPool.query("DELETE FROM periodic_report_state");
    await customerPool.query("DELETE FROM event_enrichment_state");
    await customerPool.query("DELETE FROM event_analysis_result");
    await customerPool.query("DELETE FROM story_member");
    await customerPool.query("DELETE FROM story");
  });

  // ---- helpers ----------------------------------------------------------

  async function writeVerdict(
    eventKey: string,
    spec: {
      status?: "complete" | "failed";
      coverage?: CoverageStatus;
      knownIocHit?: boolean;
    },
  ): Promise<void> {
    await customerPool.query(
      `INSERT INTO event_enrichment_state
         (source_aice_id, event_key, status, coverage_status, known_ioc_hit,
          completed_at)
       VALUES ($1, $2::numeric, $3, $4, $5, NOW())
       ON CONFLICT (source_aice_id, event_key) DO UPDATE SET
         status = EXCLUDED.status,
         coverage_status = EXCLUDED.coverage_status,
         known_ioc_hit = EXCLUDED.known_ioc_hit,
         completed_at = EXCLUDED.completed_at,
         updated_at = NOW()`,
      [
        AICE_ID,
        eventKey,
        spec.status ?? "complete",
        spec.coverage ?? "complete",
        spec.knownIocHit ?? false,
      ],
    );
  }

  async function seedLiveLeaf(eventKey: string): Promise<void> {
    await customerPool.query(
      `INSERT INTO event_analysis_result
         (aice_id, event_key, lang, model_name, model,
          model_actual_version, prompt_version,
          severity_score, likelihood_score, priority_tier,
          analysis_text, redaction_policy_version)
       VALUES ($1, $2::numeric, $3, $4, $5, 'mv', 'pv',
               0.5, 0.5, 'LOW', 'x', 'engine:1.0.0|ranges:empty')`,
      [AICE_ID, eventKey, LANG, MODEL_NAME, MODEL],
    );
  }

  async function seedStoryMember(eventKey: string): Promise<void> {
    await customerPool.query(
      `INSERT INTO story
         (story_id, story_version, kind, time_window_start, time_window_end,
          summary_payload, source_aice_id, received_at)
       VALUES (9001::bigint, 'v1', 'auto_correlated',
               '2026-05-01T00:00:00Z', '2026-05-01T01:00:00Z',
               '{}'::jsonb, $1, '2026-05-01T02:00:00Z')`,
      [AICE_ID],
    );
    await customerPool.query(
      `INSERT INTO story_member
         (story_id, story_version, member_event_key, role, event,
          redaction_policy_version)
       VALUES (9001::bigint, 'v1', $1::numeric, 'primary', '{}'::jsonb,
               'engine:1.0.0')`,
      [eventKey],
    );
  }

  async function seedAt(
    eventKeys: string[],
    nowIso: string,
    timesByKey?: Record<string, string>,
  ): Promise<void> {
    const candidates: BaselineSeedCandidate[] = eventKeys.map((eventKey) => {
      const t = new Date(timesByKey?.[eventKey] ?? nowIso);
      return {
        baselineVersion: "bv1",
        sourceAiceId: AICE_ID,
        eventKey,
        eventTime: t,
        receivedAt: t,
      };
    });
    const client: PoolClient = await authPool.connect();
    try {
      await seedBaselineEventJobs(
        {
          authClient: client,
          customerPool,
          resolveModel: async () => MODEL_PAIR,
          now: () => new Date(nowIso),
        },
        { customerId: CUSTOMER_ID, tz: "Asia/Seoul", candidates },
      );
    } finally {
      client.release();
    }
  }

  async function seed(eventKeys: string[]): Promise<void> {
    await seedAt(eventKeys, NOW);
  }

  interface JobRow {
    status: string;
    selection_tier: string | null;
    budget_day: string;
    attempts: number;
  }

  async function loadJob(eventKey: string): Promise<JobRow | null> {
    const { rows } = await authPool.query<JobRow>(
      `SELECT status, selection_tier, budget_day::text AS budget_day, attempts
         FROM event_analysis_job
        WHERE customer_id = $1 AND aice_id = $2 AND event_key = $3::numeric
          AND lang = $4 AND model_name = $5 AND model = $6`,
      [CUSTOMER_ID, AICE_ID, eventKey, LANG, MODEL_NAME, MODEL],
    );
    return rows[0] ?? null;
  }

  async function pickup(eventKey: string) {
    const { rows } = await authPool.query(
      `SELECT customer_id::text AS customer_id, aice_id,
              event_key::text AS event_key, lang, model_name, model,
              baseline_version, selection_tier, budget_day::text AS budget_day,
              event_time, received_at,
              generation, attempts, created_at
         FROM event_analysis_job
        WHERE customer_id = $1 AND aice_id = $2 AND event_key = $3::numeric
          AND lang = $4 AND model_name = $5 AND model = $6`,
      [CUSTOMER_ID, AICE_ID, eventKey, LANG, MODEL_NAME, MODEL],
    );
    return rows[0];
  }

  const analyzed = vi.fn(async () => ({ kind: "analyzed", generation: 1 }));
  const analyzeError = vi.fn(async () => ({
    kind: "error",
    errorCode: "storage_failed" as const,
    message: "boom",
  }));

  function baseOpts(
    overrides: Partial<ProcessEventJobOptions> = {},
  ): ProcessEventJobOptions {
    return {
      authPool,
      resolveCustomerPool: () => customerPool,
      loadVerdict: loadEventEnrichmentVerdict,
      driveEnrichment: vi.fn(runEventEnrichment),
      analyzeLeaf: analyzed as unknown as ProcessEventJobOptions["analyzeLeaf"],
      resolveCap: async () => 5,
      now: () => new Date(NOW),
      tierAEnabled: true,
      maxEnrichmentAttempts: 2,
      maxEnrichmentAgeMinutes: 600,
      ...overrides,
    };
  }

  async function process(eventKey: string, opts: ProcessEventJobOptions) {
    await processEventJob(await pickup(eventKey), opts);
  }

  // ---- seeding / dedup --------------------------------------------------

  it("seeds held rows for loose events; dedups story members and live leaves", async () => {
    await seedStoryMember("1"); // story member → skipped
    await seedLiveLeaf("2"); // live leaf for the target variant → skipped
    await seed(["1", "2", "3"]); // 3 is loose + unanalyzed

    expect(await loadJob("1")).toBeNull();
    expect(await loadJob("2")).toBeNull();
    const held = await loadJob("3");
    expect(held).not.toBeNull();
    expect(held?.status).toBe("queued");
    expect(held?.selection_tier).toBeNull(); // held: not yet classified
  });

  // ---- tier A -----------------------------------------------------------

  it("always analyzes a tier-A IOC verdict", async () => {
    await writeVerdict("10", { knownIocHit: true, coverage: "complete" });
    await seed(["10"]);
    await process("10", baseOpts());
    const job = await loadJob("10");
    expect(job?.selection_tier).toBe("tier_a");
    expect(job?.status).toBe("done");
    expect(analyzed).toHaveBeenCalled();
  });

  it("a monotonic true verdict under non-complete coverage still routes to tier A", async () => {
    await writeVerdict("11", { knownIocHit: true, coverage: "stale" });
    await seed(["11"]);
    await process("11", baseOpts());
    expect((await loadJob("11"))?.selection_tier).toBe("tier_a");
  });

  // ---- tier B + budget reservation -------------------------------------

  it("a complete-coverage miss is tier B and analyzed within budget", async () => {
    await writeVerdict("20", { knownIocHit: false, coverage: "complete" });
    await seed(["20"]);
    await process("20", baseOpts({ resolveCap: async () => 5 }));
    const job = await loadJob("20");
    expect(job?.selection_tier).toBe("tier_b");
    expect(job?.status).toBe("done");
  });

  it("cap = 0 disables tier B (budget_skipped, terminal, not retried)", async () => {
    await writeVerdict("21", { knownIocHit: false, coverage: "complete" });
    await seed(["21"]);
    await process("21", baseOpts({ resolveCap: async () => 0 }));
    const job = await loadJob("21");
    expect(job?.selection_tier).toBe("tier_b");
    expect(job?.status).toBe("budget_skipped");
  });

  it("seed-time reservation counts in-flight rows: cap+N → exactly cap admitted, N skipped", async () => {
    const cap = 2;
    const keys = ["30", "31", "32", "33"]; // cap + N (N = 2)
    for (const k of keys) {
      await writeVerdict(k, { knownIocHit: false, coverage: "complete" });
    }
    await seed(keys);
    // Zero completions: the analyze step ERRORS, so admitted rows never reach
    // `done` — they stay in-flight (queued). The cap must still hold.
    const opts = baseOpts({
      resolveCap: async () => cap,
      analyzeLeaf:
        analyzeError as unknown as ProcessEventJobOptions["analyzeLeaf"],
    });
    for (const k of keys) await process(k, opts);

    const { rows: admitted } = await authPool.query<{ n: string }>(
      `SELECT COUNT(*) AS n FROM event_analysis_job
        WHERE customer_id = $1 AND selection_tier = 'tier_b'
          AND status <> 'budget_skipped'`,
      [CUSTOMER_ID],
    );
    const { rows: skipped } = await authPool.query<{ n: string }>(
      `SELECT COUNT(*) AS n FROM event_analysis_job
        WHERE customer_id = $1 AND status = 'budget_skipped'`,
      [CUSTOMER_ID],
    );
    expect(Number(admitted[0].n)).toBe(cap);
    expect(Number(skipped[0].n)).toBe(keys.length - cap);
    // None completed — proves the count is a reservation, not a done tally.
    const { rows: done } = await authPool.query<{ n: string }>(
      `SELECT COUNT(*) AS n FROM event_analysis_job
        WHERE customer_id = $1 AND status = 'done'`,
      [CUSTOMER_ID],
    );
    expect(Number(done[0].n)).toBe(0);
  });

  it("tier-A volume does NOT consume the tier-B budget", async () => {
    await writeVerdict("40", { knownIocHit: true, coverage: "complete" }); // A
    await writeVerdict("41", { knownIocHit: false, coverage: "complete" }); // B
    await writeVerdict("42", { knownIocHit: false, coverage: "complete" }); // B
    await seed(["40", "41", "42"]);
    const opts = baseOpts({ resolveCap: async () => 1 });
    await process("40", opts); // tier A — must not reserve a tier-B slot
    await process("41", opts); // tier B — admitted (count 0 < 1)
    await process("42", opts); // tier B — skipped (count 1, not < 1)

    expect((await loadJob("40"))?.selection_tier).toBe("tier_a");
    expect((await loadJob("41"))?.status).toBe("done"); // admitted + analyzed
    expect((await loadJob("42"))?.status).toBe("budget_skipped");
  });

  // ---- coverage gating / held lifecycle --------------------------------

  it("an absent verdict is HELD until a bounded enrichment drive runs", async () => {
    // No event_enrichment_state row. The drive writes a complete+true verdict
    // (simulating enrichment landing an IOC hit), which routes to tier A.
    const drive = vi.fn(async () => {
      await writeVerdict("50", { knownIocHit: true, coverage: "complete" });
      return {
        status: "complete" as const,
        knownIocHit: true,
        coverageStatus: "complete" as CoverageStatus,
        evidenceCount: 1,
      };
    });
    await seed(["50"]);
    // Before processing: held (no tier, no skip).
    expect((await loadJob("50"))?.selection_tier).toBeNull();
    await process("50", baseOpts({ driveEnrichment: drive as never }));
    expect(drive).toHaveBeenCalledTimes(1);
    expect((await loadJob("50"))?.selection_tier).toBe("tier_a");
  });

  it("a negative under non-complete coverage is held + re-checked, never silently budget_skipped, and falls back to tier B on exhaustion", async () => {
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      // The drive keeps writing a non-conclusive (unknown coverage) negative.
      const drive = vi.fn(async () => {
        await writeVerdict("60", {
          status: "complete",
          knownIocHit: false,
          coverage: "unknown",
        });
        return {
          status: "complete" as const,
          knownIocHit: false,
          coverageStatus: "unknown" as CoverageStatus,
          evidenceCount: 0,
        };
      });
      const opts = baseOpts({
        driveEnrichment: drive as never,
        maxEnrichmentAttempts: 2,
        resolveCap: async () => 5,
      });
      await seed(["60"]);

      // First processing: held, re-queued (NOT budget_skipped).
      await process("60", opts);
      let job = await loadJob("60");
      expect(job?.selection_tier).toBeNull();
      expect(job?.status).toBe("queued");
      expect(job?.attempts).toBe(1);

      // Second processing: bound exhausted → tier-B fallback (with metric).
      await process("60", opts);
      job = await loadJob("60");
      expect(job?.selection_tier).toBe("tier_b");
      expect(job?.status).toBe("done"); // admitted + analyzed
      expect(
        infoSpy.mock.calls.some((c) =>
          String(c[0]).includes("coverage_holdfallback"),
        ),
      ).toBe(true);
    } finally {
      infoSpy.mockRestore();
    }
  });

  it("a held event upgrades to tier A if the verdict later flips to true", async () => {
    let call = 0;
    const drive = vi.fn(async () => {
      call += 1;
      if (call === 1) {
        await writeVerdict("70", {
          knownIocHit: false,
          coverage: "unknown",
        });
      } else {
        await writeVerdict("70", { knownIocHit: true, coverage: "complete" });
      }
      return {
        status: "complete" as const,
        knownIocHit: call > 1,
        coverageStatus: (call > 1 ? "complete" : "unknown") as CoverageStatus,
        evidenceCount: call > 1 ? 1 : 0,
      };
    });
    const opts = baseOpts({ driveEnrichment: drive as never });
    await seed(["70"]);
    await process("70", opts); // held → requeue
    expect((await loadJob("70"))?.selection_tier).toBeNull();
    await process("70", opts); // verdict flipped true → tier A
    expect((await loadJob("70"))?.selection_tier).toBe("tier_a");
  });

  // ---- customer-tz budget_day boundary ---------------------------------

  it("budget_day is the CUSTOMER-tz calendar day, not the UTC day", async () => {
    // 2026-06-04T16:00Z is 2026-06-05 01:00 in Asia/Seoul (UTC+9): the
    // budget_day must follow the customer tz, not UTC (still 06-04).
    await seedAt(["90"], "2026-06-04T16:00:00.000Z");
    expect((await loadJob("90"))?.budget_day).toBe("2026-06-05");
  });

  it("the tier-B budget resets on the customer-tz day boundary", async () => {
    // cap = 1. Two complete-coverage misses seeded into two different
    // customer-tz days each get their own budget_day, so BOTH are admitted
    // — one day's spend does not consume the next day's budget.
    await writeVerdict("91", { knownIocHit: false, coverage: "complete" });
    await writeVerdict("92", { knownIocHit: false, coverage: "complete" });
    await seedAt(["91"], "2026-06-04T12:00:00.000Z"); // 06-04 KST
    await seedAt(["92"], "2026-06-05T12:00:00.000Z"); // 06-05 KST
    const opts = baseOpts({ resolveCap: async () => 1 });
    await process("91", opts);
    await process("92", opts);

    const a = await loadJob("91");
    const b = await loadJob("92");
    expect(a?.budget_day).toBe("2026-06-04");
    expect(b?.budget_day).toBe("2026-06-05");
    // Both admitted: separate days, separate cap-of-1 budgets.
    expect(a?.status).toBe("done");
    expect(b?.status).toBe("done");
  });

  // ---- neutral chronological tier-B admission order --------------------

  it("tier-B admission follows neutral event_time order under a low cap", async () => {
    // Three loose complete-coverage misses with distinct event_times, in a
    // key order that is the REVERSE of chronological order. cap = 2: the two
    // EARLIEST by event_time must be admitted and the latest budget_skipped,
    // proving admission follows the neutral `event_time` order rather than the
    // arbitrary `(aice_id, event_key)` key order.
    for (const k of ["100", "101", "102"]) {
      await writeVerdict(k, { knownIocHit: false, coverage: "complete" });
    }
    await seedAt(["100", "101", "102"], NOW, {
      "100": "2026-06-04T12:00:02.000Z", // latest by event_time
      "101": "2026-06-04T12:00:01.000Z",
      "102": "2026-06-04T12:00:00.000Z", // earliest by event_time
    });
    // tickEventJobsOnce picks queued rows in the pickup ORDER BY (event_time)
    // and processes them in that order, so the cap reservation sees the
    // earliest events first.
    await tickEventJobsOnce(
      authPool,
      10,
      baseOpts({ resolveCap: async () => 2 }),
    );

    expect((await loadJob("102"))?.status).toBe("done"); // earliest → admitted
    expect((await loadJob("101"))?.status).toBe("done"); // 2nd → admitted
    expect((await loadJob("100"))?.status).toBe("budget_skipped"); // over cap
  });

  // ---- enrichment attempts do not leak into the analysis retry budget ---

  it("a held event admitted to tier B gets a FRESH analysis retry budget", async () => {
    // Non-conclusive verdict: held + re-checked, then bound-exhausted to a
    // tier-B fallback (admitted). A transient analysis error AFTER admission
    // must re-queue with a fresh budget, not bill the enrichment re-checks
    // against MAX_ATTEMPTS (which could mark the event terminally `failed`
    // after a single analysis error).
    const drive = vi.fn(async () => {
      await writeVerdict("110", { knownIocHit: false, coverage: "unknown" });
      return {
        status: "complete" as const,
        knownIocHit: false,
        coverageStatus: "unknown" as CoverageStatus,
        evidenceCount: 0,
      };
    });
    const opts = baseOpts({
      driveEnrichment: drive as never,
      maxEnrichmentAttempts: 2,
      resolveCap: async () => 5,
      analyzeLeaf:
        analyzeError as unknown as ProcessEventJobOptions["analyzeLeaf"],
    });
    await seed(["110"]);

    // First processing: held, re-queued (enrichment attempts → 1).
    await process("110", opts);
    expect((await loadJob("110"))?.status).toBe("queued");
    expect((await loadJob("110"))?.attempts).toBe(1);

    // Second processing: bound exhausted → tier-B fallback admitted, then the
    // analyze step errors. The job re-queues with a FRESH analysis budget:
    // attempts = 1 (a first 0 → 1 analysis attempt), NOT 2 (which would mean
    // the enrichment re-check leaked into the analysis retry budget).
    await process("110", opts);
    const job = await loadJob("110");
    expect(job?.selection_tier).toBe("tier_b");
    expect(job?.status).toBe("queued"); // retryable, NOT terminal failed
    expect(job?.attempts).toBe(1); // fresh budget (would be 2 without the fix)
  });

  // ---- report event-path re-dirty on async leaf completion -------------

  it("re-dirties the periodic report bucket when a loose-event leaf is analyzed", async () => {
    // A ready DAILY report (already generated → a done job) for the event's
    // customer-tz bucket. When the async auto-analysis leaf lands, the worker
    // must flip the report back to dirty so the report event path regenerates
    // with the new leaf — otherwise the loose event stays invisible until
    // unrelated activity re-dirties the bucket.
    const bucket = "2026-06-04"; // NOW (12:00Z) is 21:00 KST on 06-04
    await authPool.query(
      `INSERT INTO periodic_report_state
         (customer_id, period, bucket_date, tz, status, last_event_at)
       VALUES ($1, 'DAILY', $2::date, 'Asia/Seoul', 'ready', $3::timestamptz)`,
      [CUSTOMER_ID, bucket, NOW],
    );
    await authPool.query(
      `INSERT INTO periodic_report_job
         (customer_id, period, bucket_date, tz, lang, model_name, model,
          status)
       VALUES ($1, 'DAILY', $2::date, 'Asia/Seoul', $3, $4, $5, 'done')`,
      [CUSTOMER_ID, bucket, LANG, MODEL_NAME, MODEL],
    );

    await writeVerdict("120", { knownIocHit: true, coverage: "complete" });
    await seed(["120"]); // event_time defaults to NOW → 06-04 KST bucket
    await process("120", baseOpts());
    expect((await loadJob("120"))?.status).toBe("done");

    const { rows } = await authPool.query<{ status: string }>(
      `SELECT status FROM periodic_report_state
        WHERE customer_id = $1 AND period = 'DAILY'
          AND bucket_date = $2::date AND tz = 'Asia/Seoul'`,
      [CUSTOMER_ID, bucket],
    );
    expect(rows[0]?.status).toBe("dirty");
  });

  it("the tier-A kill switch holds a known-IOC event (never demoted to tier B)", async () => {
    await writeVerdict("80", { knownIocHit: true, coverage: "complete" });
    await seed(["80"]);
    await process("80", baseOpts({ tierAEnabled: false }));
    const job = await loadJob("80");
    // Held (re-queued), NOT analyzed and NOT budget_skipped.
    expect(job?.selection_tier).toBeNull();
    expect(job?.status).toBe("queued");
  });
});
