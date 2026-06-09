import { join } from "node:path";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../migrate";
import {
  closeAdminPool,
  createTestDatabase,
  dropTestDatabase,
  hasPostgres,
} from "./db-test-helpers";

const GROUP_MIGRATIONS_DIR = join(process.cwd(), "migrations", "group");
const LOCK_ID_GROUP = 1003;

// Real table names the group v1 schema must NOT contain. The "results
// only, no raw member events" guarantee is structural: this asserts on the
// concrete excluded names (raw-event / ingestion family + customer_id-keyed
// result/redaction tables, deferred to #508), not a wildcard.
const EXCLUDED_TABLES = [
  // raw-event / ingestion family
  "detection_events",
  "baseline_event",
  "story",
  "story_member",
  "policy_run",
  "policy_event",
  // customer_id-keyed result / redaction tables
  "event_analysis_result",
  "story_analysis_result",
  "event_redaction_map",
];

describe.skipIf(!hasPostgres)("Schema verification (group_db)", () => {
  let dbName: string;
  let pool: Pool;

  beforeAll(async () => {
    const db = await createTestDatabase("schema_group");
    dbName = db.dbName;
    pool = db.pool;

    // The group schema grants to the shared subject-DB runtime role
    // `aimer_customer` (reused — see group-db.ts). Ensure it exists.
    await pool.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'aimer_customer') THEN
          CREATE ROLE aimer_customer LOGIN PASSWORD 'changeme';
        END IF;
      END $$
    `);

    await runMigrations(pool, GROUP_MIGRATIONS_DIR, LOCK_ID_GROUP);
  });

  afterAll(async () => {
    await dropTestDatabase(dbName, pool);
    await closeAdminPool();
  });

  it("applies all group migrations cleanly", async () => {
    const { rows } = await pool.query(
      "SELECT version FROM _migrations ORDER BY version",
    );
    // 0000_extensions, 0001_periodic_report_result
    expect(rows.map((r) => r.version)).toEqual(["0000", "0001"]);
  });

  it("creates periodic_report_result keyed by subject_id (not customer_id)", async () => {
    const { rows } = await pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'periodic_report_result'
        ORDER BY ordinal_position`,
    );
    const names = rows.map((r) => r.column_name);
    expect(names).toContain("subject_id");
    expect(names).not.toContain("customer_id");
  });

  it("keys periodic_report_result's primary key on subject_id", async () => {
    const { rows } = await pool.query<{ column_name: string }>(
      `SELECT a.attname AS column_name
         FROM pg_index i
         JOIN pg_attribute a
           ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
        WHERE i.indrelid = 'periodic_report_result'::regclass
          AND i.indisprimary
        ORDER BY a.attnum`,
    );
    const pkCols = rows.map((r) => r.column_name);
    expect(pkCols[0]).toBe("subject_id");
  });

  it("accepts an inserted periodic_report_result row", async () => {
    await expect(
      pool.query(
        `INSERT INTO periodic_report_result
           (subject_id, period, bucket_date, tz, lang, model_name, model,
            model_actual_version, prompt_version, generation,
            aggregate_severity_score, aggregate_likelihood_score,
            priority_tier, sections_jsonb, input_event_refs, input_story_refs,
            input_hash, redaction_policy_version)
         VALUES ($1, 'daily', '2026-01-01', 'UTC', 'en', 'm', 'm', 'v', 'p', 1,
                 0.5, 0.5, 'LOW', '{}'::jsonb, '[]'::jsonb, '[]'::jsonb,
                 'hash', 'rpv')`,
        ["a0000000-0000-0000-0000-000000000001"],
      ),
    ).resolves.toBeDefined();
  });

  it("excludes raw-event and customer_id-keyed tables from v1 (#508)", async () => {
    const { rows } = await pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_name = ANY($1::text[])`,
      [EXCLUDED_TABLES],
    );
    expect(rows.map((r) => r.table_name)).toEqual([]);
  });

  it("contains only the periodic-report result family (no extra tables)", async () => {
    const { rows } = await pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name <> '_migrations'
        ORDER BY table_name`,
    );
    expect(rows.map((r) => r.table_name)).toEqual(["periodic_report_result"]);
  });
});
