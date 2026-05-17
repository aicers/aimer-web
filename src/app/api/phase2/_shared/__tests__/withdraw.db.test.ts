import { join } from "node:path";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  closeAdminPool,
  createTestDatabase,
  dropTestDatabase,
  hasPostgres,
} from "@/lib/db/__tests__/db-test-helpers";
import { runMigrations } from "@/lib/db/migrate";
import {
  ingestBaselineBatch,
  ingestPolicyRun,
  ingestStoryBatch,
} from "../ingest";
import { executeWithdraw } from "../withdraw";

const CUSTOMER_MIGRATIONS_DIR = join(process.cwd(), "migrations", "customer");
const LOCK_ID_CUSTOMER = 1002;

const baselineEvent = (key: string, version = "bv-1") => ({
  event_key: key,
  event_time: "2026-01-02T03:04:05Z",
  kind: "dns",
  category: null,
  primary_asset: null,
  raw_score: 0.5,
  selector_tags: [],
  raw_event: {},
  score_window_context: {
    kind_cohort_window: {
      from: "2026-01-01T00:00:00Z",
      to: "2026-01-02T00:00:00Z",
    },
    kind_cohort_size: 1,
    baseline_rank_snapshot: 0.5,
  },
  window_signals: {},
  scoring_weights_snapshot: {},
  // unused by test but typed
  asset_context: null,
  baseline_version: version,
});

describe.skipIf(!hasPostgres)("executeWithdraw", () => {
  let dbName: string;
  let pool: Pool;

  beforeAll(async () => {
    const db = await createTestDatabase("phase2_withdraw");
    dbName = db.dbName;
    pool = db.pool;
    await runMigrations(pool, CUSTOMER_MIGRATIONS_DIR, LOCK_ID_CUSTOMER);
  });

  afterAll(async () => {
    await dropTestDatabase(dbName, pool);
    await closeAdminPool();
  });

  it("deletes baseline_event rows by (baseline_version, event_key)", async () => {
    await ingestBaselineBatch(
      pool,
      {
        external_key: "ext",
        baseline_version: "wbv-1",
        events: [baselineEvent("1001"), baselineEvent("1002")],
      },
      "aice-1",
    );

    const result = await executeWithdraw(pool, {
      external_key: "ext",
      withdrawals: [
        {
          kind: "baseline_event",
          baseline_version: "wbv-1",
          event_keys: ["1001", "9999"], // 9999 = not found
        },
      ],
    });

    expect(result.withdrawn).toBe(1);
    expect(result.notFound).toBe(1);
    expect(result.kindsTouched).toEqual(["baseline_event"]);

    const { rows } = await pool.query(
      "SELECT event_key::text AS k FROM baseline_event WHERE baseline_version = 'wbv-1' ORDER BY k",
    );
    expect(rows.map((r) => r.k)).toEqual(["1002"]);
  });

  it("deletes story rows and cascades to story_member", async () => {
    await ingestStoryBatch(
      pool,
      {
        external_key: "ext",
        stories: [
          {
            story_id: "8001",
            story_version: "v1",
            kind: "auto_correlated",
            time_window: {
              start: "2026-01-02T01:00:00Z",
              end: "2026-01-02T02:00:00Z",
            },
            summary_payload: {},
            members: [
              { event_key: "1", role: "primary", event: {} },
              { event_key: "2", role: "context", event: {} },
            ],
          },
        ],
      },
      "aice-1",
    );

    const result = await executeWithdraw(pool, {
      external_key: "ext",
      withdrawals: [
        { kind: "story", story_id: "8001", story_version: "v1" },
        { kind: "story", story_id: "8001", story_version: "vMissing" },
      ],
    });

    expect(result.withdrawn).toBe(1);
    expect(result.notFound).toBe(1);

    const storyRows = await pool.query(
      "SELECT 1 FROM story WHERE story_id = 8001 AND story_version = 'v1'",
    );
    expect(storyRows.rowCount).toBe(0);
    const memberRows = await pool.query(
      "SELECT 1 FROM story_member WHERE story_id = 8001 AND story_version = 'v1'",
    );
    expect(memberRows.rowCount).toBe(0); // cascaded
  });

  it("deletes policy_run rows and cascades to policy_event", async () => {
    await ingestPolicyRun(
      pool,
      {
        external_key: "ext",
        run: {
          run_id: "9001",
          period_start: "2026-01-02T03:00:00Z",
          period_end: "2026-01-02T04:00:00Z",
          created_at: "2026-01-02T04:00:01Z",
          baseline_version: "pbv",
          policies_fingerprint: "pfp",
          exclusions_fingerprint: "efp",
          status: "ready",
        },
        events: [
          {
            event_key: "10",
            event_time: "2026-01-02T03:30:00Z",
            kind: "dns",
            policy_triage_snapshot: [],
          },
          {
            event_key: "11",
            event_time: "2026-01-02T03:31:00Z",
            kind: "http",
            policy_triage_snapshot: [],
          },
        ],
      },
      "aice-1",
    );

    const result = await executeWithdraw(pool, {
      external_key: "ext",
      withdrawals: [{ kind: "policy_run", run_id: "9001" }],
    });

    expect(result.withdrawn).toBe(1);
    expect(result.notFound).toBe(0);

    const eventRows = await pool.query(
      "SELECT 1 FROM policy_event WHERE run_id = 9001",
    );
    expect(eventRows.rowCount).toBe(0); // cascaded
  });

  it("deletes specific policy_event rows leaving the run intact", async () => {
    await ingestPolicyRun(
      pool,
      {
        external_key: "ext",
        run: {
          run_id: "9100",
          period_start: "2026-01-02T03:00:00Z",
          period_end: "2026-01-02T04:00:00Z",
          created_at: "2026-01-02T04:00:01Z",
          baseline_version: "pbv",
          policies_fingerprint: "pfp",
          exclusions_fingerprint: "efp",
          status: "ready",
        },
        events: [
          {
            event_key: "20",
            event_time: "2026-01-02T03:30:00Z",
            kind: "dns",
            policy_triage_snapshot: [],
          },
          {
            event_key: "21",
            event_time: "2026-01-02T03:31:00Z",
            kind: "http",
            policy_triage_snapshot: [],
          },
        ],
      },
      "aice-1",
    );

    const result = await executeWithdraw(pool, {
      external_key: "ext",
      withdrawals: [
        { kind: "policy_event", run_id: "9100", event_keys: ["20"] },
      ],
    });

    expect(result.withdrawn).toBe(1);
    expect(result.notFound).toBe(0);

    const runRows = await pool.query(
      "SELECT 1 FROM policy_run WHERE run_id = 9100",
    );
    expect(runRows.rowCount).toBe(1);
    const remainingEvents = await pool.query(
      "SELECT event_key::text AS k FROM policy_event WHERE run_id = 9100",
    );
    expect(remainingEvents.rows.map((r) => r.k)).toEqual(["21"]);
  });

  it("mixed multi-kind withdrawals run atomically and sum counts", async () => {
    await ingestBaselineBatch(
      pool,
      {
        external_key: "ext",
        baseline_version: "mbv",
        events: [baselineEvent("3001")],
      },
      "aice-1",
    );
    await ingestStoryBatch(
      pool,
      {
        external_key: "ext",
        stories: [
          {
            story_id: "8100",
            story_version: "v1",
            kind: "auto_correlated",
            time_window: {
              start: "2026-01-02T01:00:00Z",
              end: "2026-01-02T02:00:00Z",
            },
            summary_payload: {},
            members: [],
          },
        ],
      },
      "aice-1",
    );

    const result = await executeWithdraw(pool, {
      external_key: "ext",
      withdrawals: [
        {
          kind: "baseline_event",
          baseline_version: "mbv",
          event_keys: ["3001"],
        },
        { kind: "story", story_id: "8100", story_version: "v1" },
      ],
    });

    expect(result.withdrawn).toBe(2);
    expect(result.notFound).toBe(0);
    expect(new Set(result.kindsTouched)).toEqual(
      new Set(["baseline_event", "story"]),
    );
  });
});
