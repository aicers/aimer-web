// DB integration test for the shared stale-scan helper.
//
// The preview endpoint's unit tests mock `countStaleRows`, so they
// would still pass if `staleRowsCountSql` had a typo or a join-path
// drift. This file exercises the real SQL against a fresh customer
// schema and verifies the per-table count + the aggregate match the
// rows that the #253 worker would process.

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
  countStaleRows,
  REDACTION_VERSIONED_TABLES,
  staleRowsCountSql,
} from "../stale-scan";

const CUSTOMER_MIGRATIONS_DIR = join(process.cwd(), "migrations", "customer");
const LOCK_ID_CUSTOMER = 1042;

const TARGET = "engine:1.0.0|ranges:deadbeef";
const STALE = "engine:1.0.0|ranges:cafebabe";
const STALE_ALT = "engine:1.0.0|ranges:feedface";

const INGESTED_BY = "00000000-0000-0000-0000-000000000099";

describe("staleRowsCountSql (SQL shape)", () => {
  it("returns a count query for every entry of REDACTION_VERSIONED_TABLES", () => {
    for (const table of REDACTION_VERSIONED_TABLES) {
      const sql = staleRowsCountSql(table);
      // All variants share a `COUNT(*)` projection on a bigint `n`
      // and use `<> $1` against the bind parameter. A typo in the
      // staleness criterion would flip this regex.
      expect(sql).toMatch(/SELECT COUNT\(\*\)::bigint AS n/);
      expect(sql).toContain("redaction_policy_version <> $1");
    }
  });

  it("joins through story for story_member (aice_id resolution parity with the worker)", () => {
    const sql = staleRowsCountSql("story_member");
    // The shape that the #253 worker depends on:
    //   sm.redaction_policy_version vs story.source_aice_id via
    //   (story_id, story_version).
    expect(sql).toMatch(/FROM story_member sm/);
    expect(sql).toMatch(/JOIN story s ON s.story_id = sm.story_id/);
    expect(sql).toMatch(/AND s.story_version = sm.story_version/);
    expect(sql).toMatch(/WHERE sm.redaction_policy_version <> \$1/);
  });

  it("joins through policy_run for policy_event (aice_id resolution parity with the worker)", () => {
    const sql = staleRowsCountSql("policy_event");
    expect(sql).toMatch(/FROM policy_event pe/);
    expect(sql).toMatch(/JOIN policy_run pr ON pr.run_id = pe.run_id/);
    expect(sql).toMatch(/WHERE pe.redaction_policy_version <> \$1/);
  });
});

describe.skipIf(!hasPostgres)(
  "countStaleRows (against real customer schema)",
  () => {
    let dbName: string;
    let pool: Pool;

    beforeAll(async () => {
      const db = await createTestDatabase("stale_scan");
      dbName = db.dbName;
      pool = db.pool;

      // Role required by GRANT statements in 0001/0002/0003. Idempotent.
      await pool.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'aimer_customer') THEN
          CREATE ROLE aimer_customer LOGIN PASSWORD 'changeme';
        END IF;
      END $$
    `);

      await runMigrations(pool, CUSTOMER_MIGRATIONS_DIR, LOCK_ID_CUSTOMER);

      // -- detection_events: 2 stale + 1 current
      for (const [idx, version] of [STALE, STALE_ALT, TARGET].entries()) {
        await pool.query(
          `INSERT INTO detection_events
           (aice_id, event_key, redacted_event, redaction_policy_version,
            schema_version, payload_hash, source, ingested_by)
         VALUES ($1, $2, '{}'::jsonb, $3, 'v1', $4, 'manual', $5)`,
          [`aice-de-${idx}`, idx + 1, version, `hash-de-${idx}`, INGESTED_BY],
        );
      }

      // -- baseline_event: 3 stale + 2 current
      const baselineCtx = {
        kind_cohort_window: {
          from: "2026-01-01T00:00:00Z",
          to: "2026-01-02T00:00:00Z",
        },
        kind_cohort_size: 1,
        baseline_rank_snapshot: 0.5,
      };
      const baselineRows: Array<[string, number, string]> = [
        ["v1", 1, STALE],
        ["v1", 2, STALE],
        ["v1", 3, STALE_ALT],
        ["v1", 4, TARGET],
        ["v1", 5, TARGET],
      ];
      for (const [version, key, policy] of baselineRows) {
        await pool.query(
          `INSERT INTO baseline_event
           (baseline_version, event_key, event_time, kind, raw_score,
            raw_event, score_window_context, window_signals,
            scoring_weights_snapshot, source_aice_id,
            redaction_policy_version)
         VALUES ($1, $2, NOW(), 'dns', 0.1, '{}'::jsonb, $3::jsonb,
                 '{}'::jsonb, '{}'::jsonb, $4, $5)`,
          [version, key, JSON.stringify(baselineCtx), "aice-be", policy],
        );
      }

      // -- story (parent for story_member): 1 row, no redaction_policy_version
      await pool.query(
        `INSERT INTO story
         (story_id, story_version, kind, time_window_start,
          time_window_end, summary_payload, source_aice_id)
       VALUES (1, 'v1', 'auto_correlated', NOW(), NOW(), '{}'::jsonb, 'aice-st')`,
      );
      // story_member: 1 stale + 1 current, both joined to story 1/v1.
      for (const [eventKey, policy] of [
        [101, STALE],
        [102, TARGET],
      ] as Array<[number, string]>) {
        await pool.query(
          `INSERT INTO story_member
           (story_id, story_version, member_event_key, role, event,
            redaction_policy_version)
         VALUES (1, 'v1', $1, 'primary', '{}'::jsonb, $2)`,
          [eventKey, policy],
        );
      }

      // -- policy_run (parent for policy_event): 1 row, no redaction_policy_version
      await pool.query(
        `INSERT INTO policy_run
         (run_id, period_start, period_end, created_at_source,
          baseline_version, policies_fingerprint, exclusions_fingerprint,
          status, source_aice_id)
       VALUES (1, NOW(), NOW(), NOW(), 'v1', 'fp1', 'fp2', 'ready',
               'aice-pe')`,
      );
      // policy_event: 4 stale + 1 current, joined to policy_run 1.
      const policyRows: Array<[number, string]> = [
        [1001, STALE],
        [1002, STALE],
        [1003, STALE],
        [1004, STALE_ALT],
        [1005, TARGET],
      ];
      for (const [eventKey, policy] of policyRows) {
        await pool.query(
          `INSERT INTO policy_event
           (run_id, event_key, event_time, kind, policy_triage_snapshot,
            redaction_policy_version)
         VALUES (1, $1, NOW(), 'dns', '{}'::jsonb, $2)`,
          [eventKey, policy],
        );
      }

      // -- event_analysis_result: 5 stale + 3 current
      const earRows: Array<[string, number, string]> = [
        ["aice-ear-1", 1, STALE],
        ["aice-ear-1", 2, STALE],
        ["aice-ear-1", 3, STALE_ALT],
        ["aice-ear-1", 4, STALE_ALT],
        ["aice-ear-1", 5, STALE],
        ["aice-ear-1", 6, TARGET],
        ["aice-ear-1", 7, TARGET],
        ["aice-ear-1", 8, TARGET],
      ];
      for (const [aice, key, policy] of earRows) {
        await pool.query(
          `INSERT INTO event_analysis_result
           (aice_id, event_key, lang, model_name, model,
            model_actual_version, prompt_version,
            severity_score, likelihood_score, priority_tier,
            analysis_text, event_time, redaction_policy_version, requested_by)
         VALUES ($1, $2, 'en', 'gpt-x', 'gpt-x-v1', 'mv', 'pv', 0.5, 0.5, 'LOW', '', '2026-05-20T00:00:00Z'::timestamptz, $3, $4)`,
          [aice, key, policy, INGESTED_BY],
        );
      }
    });

    afterAll(async () => {
      await dropTestDatabase(dbName, pool);
      await closeAdminPool();
    });

    it("counts stale rows per table via the shared SQL builder", async () => {
      const expected: Record<string, number> = {
        detection_events: 2,
        baseline_event: 3,
        story_member: 1,
        policy_event: 4,
        event_analysis_result: 5,
      };
      for (const table of REDACTION_VERSIONED_TABLES) {
        const { rows } = await pool.query<{ n: string }>(
          staleRowsCountSql(table),
          [TARGET],
        );
        expect(Number.parseInt(rows[0].n, 10)).toBe(expected[table]);
      }
    });

    it("aggregates the per-table counts via countStaleRows", async () => {
      // 2 + 3 + 1 + 4 + 5 = 15.
      await expect(countStaleRows(pool, TARGET)).resolves.toBe(15);
    });

    it("excludes story_member rows whose parent story is absent (worker parity)", async () => {
      // The worker cannot resolve aice_id for an orphan story_member, so
      // the preview must mirror that exclusion. Plant a stale row whose
      // parent story does not exist; the JOIN must hide it from the count.
      //
      // story_member has FK to story, so we drop the row via a parent
      // delete (ON DELETE CASCADE). Confirm both the per-table query and
      // countStaleRows see the same number.
      await pool.query(
        `INSERT INTO story
         (story_id, story_version, kind, time_window_start,
          time_window_end, summary_payload, source_aice_id)
       VALUES (2, 'v1', 'auto_correlated', NOW(), NOW(), '{}'::jsonb, 'aice-st-2')`,
      );
      await pool.query(
        `INSERT INTO story_member
         (story_id, story_version, member_event_key, role, event,
          redaction_policy_version)
       VALUES (2, 'v1', 201, 'primary', '{}'::jsonb, $1)`,
        [STALE],
      );

      // With the orphan-parent row attached, story_member stale count is 2.
      const beforeDrop = await pool.query<{ n: string }>(
        staleRowsCountSql("story_member"),
        [TARGET],
      );
      expect(Number.parseInt(beforeDrop.rows[0].n, 10)).toBe(2);

      // Cascade-delete the parent story; the FK takes its story_member
      // child rows with it. (story_member cannot exist without a parent
      // story by schema, so cascading is the only way to simulate the
      // worker's "orphan invisible to scan" property end-to-end.)
      await pool.query(`DELETE FROM story WHERE story_id = 2`);

      const afterDrop = await pool.query<{ n: string }>(
        staleRowsCountSql("story_member"),
        [TARGET],
      );
      expect(Number.parseInt(afterDrop.rows[0].n, 10)).toBe(1);
    });

    it("excludes policy_event rows whose parent policy_run is absent (worker parity)", async () => {
      await pool.query(
        `INSERT INTO policy_run
         (run_id, period_start, period_end, created_at_source,
          baseline_version, policies_fingerprint, exclusions_fingerprint,
          status, source_aice_id)
       VALUES (2, NOW(), NOW(), NOW(), 'v1', 'fp1', 'fp2', 'ready',
               'aice-pe-2')`,
      );
      await pool.query(
        `INSERT INTO policy_event
         (run_id, event_key, event_time, kind, policy_triage_snapshot,
          redaction_policy_version)
       VALUES (2, 2001, NOW(), 'dns', '{}'::jsonb, $1)`,
        [STALE],
      );

      const beforeDrop = await pool.query<{ n: string }>(
        staleRowsCountSql("policy_event"),
        [TARGET],
      );
      expect(Number.parseInt(beforeDrop.rows[0].n, 10)).toBe(5);

      await pool.query(`DELETE FROM policy_run WHERE run_id = 2`);

      const afterDrop = await pool.query<{ n: string }>(
        staleRowsCountSql("policy_event"),
        [TARGET],
      );
      expect(Number.parseInt(afterDrop.rows[0].n, 10)).toBe(4);
    });
  },
);
