import { join } from "node:path";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../migrate";
import {
  closeAdminPool,
  createRolePool,
  createTestDatabase,
  dropTestDatabase,
  hasPostgres,
} from "./db-test-helpers";

const CUSTOMER_MIGRATIONS_DIR = join(process.cwd(), "migrations", "customer");
const LOCK_ID_CUSTOMER = 1002;

describe.skipIf(!hasPostgres)("Schema verification (customer_db)", () => {
  let dbName: string;
  let pool: Pool;

  beforeAll(async () => {
    const db = await createTestDatabase("schema_customer");
    dbName = db.dbName;
    pool = db.pool;

    await runMigrations(pool, CUSTOMER_MIGRATIONS_DIR, LOCK_ID_CUSTOMER);
  });

  afterAll(async () => {
    await dropTestDatabase(dbName, pool);
    await closeAdminPool();
  });

  it("applies all customer migrations cleanly", async () => {
    const { rows } = await pool.query(
      "SELECT version FROM _migrations ORDER BY version",
    );
    // 0000_extensions, 0001_detection_events, 0002_phase2_tables,
    // 0003_redaction_foundation, 0004_retention_sweeper_support,
    // 0005_drop_analysis_narrative, 0006_redaction_job_worker_grants,
    // 0007_analysis_result_tables (RFC 0002 Phase 0, #294),
    // 0008_event_analysis_result_generation (RFC 0002 Phase 2, #297),
    // 0009_citation_reverse_lookup_gin (T2, #396),
    // 0010_ioc_enrichment (RFC 0003 P1a, #361)
    expect(rows.map((r) => r.version)).toEqual([
      "0000",
      "0001",
      "0002",
      "0003",
      "0004",
      "0005",
      "0006",
      "0007",
      "0008",
      "0009",
      "0010",
    ]);
  });

  it("creates the five remaining Phase 2 tables (analysis_narrative dropped in 0005)", async () => {
    const { rows } = await pool.query(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name IN (
          'baseline_event',
          'story',
          'story_member',
          'policy_run',
          'policy_event',
          'analysis_narrative'
        )
      ORDER BY table_name
    `);
    expect(rows.map((r) => r.table_name)).toEqual([
      "baseline_event",
      "policy_event",
      "policy_run",
      "story",
      "story_member",
    ]);
  });

  it("drops analysis_narrative (RFC 0001 §'analysis_narrative retirement')", async () => {
    const { rows } = await pool.query(
      `SELECT to_regclass('public.analysis_narrative') AS table_oid`,
    );
    expect(rows[0].table_oid).toBeNull();
  });

  it("creates the redaction foundation tables", async () => {
    const { rows } = await pool.query(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name IN ('event_redaction_map', 'event_analysis_result')
      ORDER BY table_name
    `);
    expect(rows.map((r) => r.table_name)).toEqual([
      "event_analysis_result",
      "event_redaction_map",
    ]);
  });

  // -- RFC 0002 Phase 0 (#294) analysis result tables --

  describe("RFC 0002 Phase 0 (#294) analysis result tables", () => {
    it("creates story_analysis_result and periodic_report_result", async () => {
      const { rows } = await pool.query(`
        SELECT table_name FROM information_schema.tables
         WHERE table_schema = 'public'
           AND table_name IN ('story_analysis_result', 'periodic_report_result')
         ORDER BY table_name`);
      expect(rows.map((r) => r.table_name)).toEqual([
        "periodic_report_result",
        "story_analysis_result",
      ]);
    });

    it("story_analysis_result has the locked round-10 + round-11 column shape", async () => {
      const { rows } = await pool.query<{
        column_name: string;
        data_type: string;
        is_nullable: string;
        column_default: string | null;
      }>(
        `SELECT column_name, data_type, is_nullable, column_default
           FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = 'story_analysis_result'`,
      );
      const byName = new Map(rows.map((c) => [c.column_name, c]));

      // Round-10 score + tier columns.
      expect(byName.get("severity_score")?.data_type).toBe("double precision");
      expect(byName.get("severity_score")?.is_nullable).toBe("NO");
      expect(byName.get("likelihood_score")?.data_type).toBe(
        "double precision",
      );
      expect(byName.get("likelihood_score")?.is_nullable).toBe("NO");
      expect(byName.get("priority_tier")?.data_type).toBe("text");
      expect(byName.get("priority_tier")?.is_nullable).toBe("NO");

      // Round-11 factor + tag columns — JSONB NOT NULL DEFAULT '[]'.
      for (const col of [
        "severity_factors",
        "likelihood_factors",
        "ttp_tags",
      ]) {
        expect(byName.get(col)?.data_type).toBe("jsonb");
        expect(byName.get(col)?.is_nullable).toBe("NO");
        expect(byName.get(col)?.column_default).toContain("'[]'");
      }
    });

    it("periodic_report_result has aggregate scores + aggregate_ttp_tags (no factor columns)", async () => {
      const { rows } = await pool.query<{
        column_name: string;
        data_type: string;
        is_nullable: string;
        column_default: string | null;
      }>(
        `SELECT column_name, data_type, is_nullable, column_default
           FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = 'periodic_report_result'`,
      );
      const byName = new Map(rows.map((c) => [c.column_name, c]));

      expect(byName.get("aggregate_severity_score")?.data_type).toBe(
        "double precision",
      );
      expect(byName.get("aggregate_likelihood_score")?.data_type).toBe(
        "double precision",
      );
      expect(byName.get("aggregate_ttp_tags")?.data_type).toBe("jsonb");
      expect(byName.get("aggregate_ttp_tags")?.is_nullable).toBe("NO");
      expect(byName.get("aggregate_ttp_tags")?.column_default).toContain(
        "'[]'",
      );

      // Issue spec: periodic reports do not score themselves and have
      // no factor columns to aggregate. Catch a regression where Phase
      // 1/2 tries to add them on the report table by mistake.
      expect(byName.has("aggregate_severity_factors")).toBe(false);
      expect(byName.has("aggregate_likelihood_factors")).toBe(false);
    });

    it("priority_tier CHECK rejects out-of-enum values on both result tables", async () => {
      await expect(
        pool.query(
          `INSERT INTO story_analysis_result
             (customer_id, story_id, lang, model_name, model,
              model_actual_version, prompt_version, generation,
              severity_score, likelihood_score, priority_tier,
              analysis_text, input_event_refs, input_hash,
              redaction_policy_version)
           VALUES (gen_random_uuid(), 1, 'ENGLISH', 'openai', 'gpt-4o',
                   'v1', 'p1', 1,
                   0.5, 0.4, 'EXTREME',
                   't', '[]'::jsonb, 'h', 'engine:1.0.0|ranges:empty')`,
        ),
      ).rejects.toThrow();
      await expect(
        pool.query(
          `INSERT INTO periodic_report_result
             (customer_id, period, bucket_date, tz, lang, model_name, model,
              model_actual_version, prompt_version, generation,
              aggregate_severity_score, aggregate_likelihood_score,
              priority_tier,
              sections_jsonb, input_event_refs, input_story_refs, input_hash,
              redaction_policy_version)
           VALUES (gen_random_uuid(), 'DAILY', DATE '2026-01-01', 'Asia/Seoul',
                   'ENGLISH', 'openai', 'gpt-4o',
                   'v1', 'p1', 1,
                   0.5, 0.4, 'EXTREME',
                   '{}'::jsonb, '[]'::jsonb, '[]'::jsonb, 'h',
                   'engine:1.0.0|ranges:empty')`,
        ),
      ).rejects.toThrow();
    });
  });

  it("restructures detection_events into per-event rows", async () => {
    // Old encrypted-batch columns are gone; new redacted-event
    // columns are present. The UNIQUE (aice_id, event_key) guard
    // backs the ingestion dedup short-circuit.
    const { rows: cols } = await pool.query<{
      column_name: string;
      data_type: string;
      is_nullable: string;
    }>(
      `SELECT column_name, data_type, is_nullable
       FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'detection_events'
       ORDER BY column_name`,
    );
    const byName = new Map(cols.map((c) => [c.column_name, c]));

    expect(byName.has("payload")).toBe(false);
    expect(byName.has("wrapped_dek")).toBe(false);
    expect(byName.has("event_count")).toBe(false);

    expect(byName.get("redacted_event")?.data_type).toBe("jsonb");
    expect(byName.get("redacted_event")?.is_nullable).toBe("NO");
    expect(byName.get("event_key")?.data_type).toBe("numeric");
    expect(byName.get("event_key")?.is_nullable).toBe("NO");
    expect(byName.get("redaction_policy_version")?.data_type).toBe("text");
    expect(byName.get("redaction_policy_version")?.is_nullable).toBe("NO");

    // UNIQUE (aice_id, event_key)
    const { rows: cons } = await pool.query<{ conname: string }>(
      `SELECT con.conname
       FROM pg_constraint con
       JOIN pg_class rel ON rel.oid = con.conrelid
       WHERE rel.relname = 'detection_events' AND con.contype = 'u'`,
    );
    expect(cons.length).toBeGreaterThan(0);

    // Duplicate (aice_id, event_key) rejected.
    await pool.query(
      `INSERT INTO detection_events
         (aice_id, event_key, redacted_event, redaction_policy_version,
          schema_version, payload_hash, source, ingested_by)
       VALUES ('aice-d1', 1, '{}'::jsonb, 'engine:1.0.0|ranges:empty',
               '1.0', 'h', 'manual', gen_random_uuid())`,
    );
    await expect(
      pool.query(
        `INSERT INTO detection_events
           (aice_id, event_key, redacted_event, redaction_policy_version,
            schema_version, payload_hash, source, ingested_by)
         VALUES ('aice-d1', 1, '{}'::jsonb, 'engine:1.0.0|ranges:empty',
                 '1.0', 'h2', 'manual', gen_random_uuid())`,
      ),
    ).rejects.toThrow();
  });

  it("changes policy_event.orig_addr / resp_addr to TEXT and adds redaction_policy_version", async () => {
    const { rows } = await pool.query<{
      column_name: string;
      data_type: string;
    }>(
      `SELECT column_name, data_type
       FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'policy_event'
         AND column_name IN ('orig_addr', 'resp_addr', 'redaction_policy_version')`,
    );
    const byName = new Map(rows.map((r) => [r.column_name, r.data_type]));
    expect(byName.get("orig_addr")).toBe("text");
    expect(byName.get("resp_addr")).toBe("text");
    expect(byName.get("redaction_policy_version")).toBe("text");
  });

  it("story.known_ioc_hit is BOOLEAN NOT NULL DEFAULT FALSE (#330)", async () => {
    // Locks the column shape so a future edit to the CREATE TABLE
    // cannot silently change nullability / default / type. The floor
    // policy in applyLikelihoodFloors treats `false` as the
    // signal-absent state — relaxing NOT NULL would let the worker
    // read `null` and the floor would silently never fire.
    const { rows } = await pool.query<{
      data_type: string;
      is_nullable: string;
      column_default: string | null;
    }>(
      `SELECT data_type, is_nullable, column_default
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'story'
          AND column_name = 'known_ioc_hit'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].data_type).toBe("boolean");
    expect(rows[0].is_nullable).toBe("NO");
    expect(rows[0].column_default).toContain("false");
  });

  it("adds redaction_policy_version to baseline_event and story_member but not story / policy_run", async () => {
    const { rows } = await pool.query<{
      table_name: string;
      column_name: string;
    }>(
      `SELECT table_name, column_name
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND column_name = 'redaction_policy_version'
       ORDER BY table_name`,
    );
    const tables = rows.map((r) => r.table_name);
    expect(tables).toContain("baseline_event");
    expect(tables).toContain("story_member");
    expect(tables).toContain("policy_event");
    expect(tables).toContain("event_analysis_result");
    expect(tables).toContain("detection_events");
    expect(tables).not.toContain("story");
    expect(tables).not.toContain("policy_run");
  });

  it("stamps generation + superseded_at on event_analysis_result re-analysis", async () => {
    // RFC 0002 #297 round-14 item 1: re-analysis no longer UPSERTs on
    // the PK. The PK carries `generation`, so force=true stamps
    // `superseded_at` on the prior generation and INSERTs generation+1.
    // First analysis writes generation 1, superseded_at NULL.
    await pool.query(
      `INSERT INTO event_analysis_result
         (aice_id, event_key, lang, model_name, model, generation,
          severity_score, likelihood_score,
          severity_factors, likelihood_factors, ttp_tags,
          priority_tier,
          analysis_text, redaction_policy_version,
          requested_by)
       VALUES ('aice-r1', 1, 'ENGLISH', 'openai', 'gpt-4o', 1,
               0.5, 0.4,
               '["s1"]'::jsonb, '["l1"]'::jsonb, '["T1078"]'::jsonb,
               'LOW',
               'first', 'engine:1.0.0|ranges:empty',
               gen_random_uuid())`,
    );

    // Re-analysis: supersede the prior generation, then INSERT gen 2.
    await pool.query(
      `UPDATE event_analysis_result SET superseded_at = NOW()
        WHERE aice_id = 'aice-r1' AND event_key = 1
          AND lang = 'ENGLISH' AND model_name = 'openai' AND model = 'gpt-4o'
          AND generation < 2 AND superseded_at IS NULL`,
    );
    await pool.query(
      `INSERT INTO event_analysis_result
         (aice_id, event_key, lang, model_name, model, generation,
          severity_score, likelihood_score,
          severity_factors, likelihood_factors, ttp_tags,
          priority_tier,
          analysis_text, redaction_policy_version,
          requested_by)
       VALUES ('aice-r1', 1, 'ENGLISH', 'openai', 'gpt-4o', 2,
               0.9, 0.85,
               '["s2"]'::jsonb, '["l2"]'::jsonb, '["T1110"]'::jsonb,
               'CRITICAL',
               'second', 'engine:1.0.0|ranges:empty',
               gen_random_uuid())`,
    );

    // The latest non-superseded row for the variant is generation 2.
    const { rows } = await pool.query<{
      generation: number;
      analysis_text: string;
      priority_tier: string;
      severity_factors: string[];
      likelihood_factors: string[];
      ttp_tags: string[];
    }>(
      `SELECT generation, analysis_text, priority_tier,
              severity_factors, likelihood_factors, ttp_tags
         FROM event_analysis_result
       WHERE aice_id = 'aice-r1' AND event_key = 1
         AND lang = 'ENGLISH' AND model_name = 'openai' AND model = 'gpt-4o'
         AND superseded_at IS NULL
       ORDER BY generation DESC
       LIMIT 1`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].generation).toBe(2);
    expect(rows[0].analysis_text).toBe("second");
    expect(rows[0].priority_tier).toBe("CRITICAL");
    expect(rows[0].severity_factors).toEqual(["s2"]);
    expect(rows[0].likelihood_factors).toEqual(["l2"]);
    expect(rows[0].ttp_tags).toEqual(["T1110"]);

    // Both generations are durable: the gen-1 row remains, stamped
    // superseded, so periodic-report citations to it still resolve.
    const { rows: gens } = await pool.query<{ c: number; live: number }>(
      `SELECT COUNT(*)::int AS c,
              COUNT(*) FILTER (WHERE superseded_at IS NULL)::int AS live
         FROM event_analysis_result
       WHERE aice_id = 'aice-r1' AND event_key = 1
         AND lang = 'ENGLISH' AND model_name = 'openai' AND model = 'gpt-4o'`,
    );
    expect(gens[0].c).toBe(2);
    expect(gens[0].live).toBe(1);

    // A different model produces an independent generation-1 row.
    await pool.query(
      `INSERT INTO event_analysis_result
         (aice_id, event_key, lang, model_name, model, generation,
          severity_score, likelihood_score,
          severity_factors, likelihood_factors, ttp_tags,
          priority_tier,
          analysis_text, redaction_policy_version,
          requested_by)
       VALUES ('aice-r1', 1, 'ENGLISH', 'openai', 'gpt-5', 1,
               0.1, 0.1,
               '[]'::jsonb, '[]'::jsonb, '[]'::jsonb,
               'LOW',
               'gpt5', 'engine:1.0.0|ranges:empty',
               gen_random_uuid())`,
    );
    const { rows: count } = await pool.query<{ c: number }>(
      `SELECT COUNT(*)::int AS c FROM event_analysis_result
       WHERE aice_id = 'aice-r1' AND event_key = 1`,
    );
    expect(count[0].c).toBe(3);
  });

  it("event_analysis_result round-11 columns: NOT NULL DEFAULT '[]' jsonb arrays", async () => {
    // The migration adds severity_factors, likelihood_factors, ttp_tags
    // as JSONB columns with NOT NULL DEFAULT '[]'. Assert each column
    // exists with the expected type / nullability / default so a future
    // accidental column-shape change in the migration is caught.
    const { rows } = await pool.query<{
      column_name: string;
      data_type: string;
      is_nullable: string;
      column_default: string;
    }>(
      `SELECT column_name, data_type, is_nullable, column_default
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'event_analysis_result'
         AND column_name IN ('severity_factors', 'likelihood_factors', 'ttp_tags')
       ORDER BY column_name`,
    );
    expect(rows.map((r) => r.column_name)).toEqual([
      "likelihood_factors",
      "severity_factors",
      "ttp_tags",
    ]);
    for (const row of rows) {
      expect(row.data_type).toBe("jsonb");
      expect(row.is_nullable).toBe("NO");
      // Postgres pretty-prints the literal default as `'[]'::jsonb`.
      expect(row.column_default).toContain("'[]'");
    }

    // INSERT without the new columns defaults each to '[]' (a JSONB
    // array). The route's loader / SELECTs rely on `jsonb_typeof = 'array'`.
    await pool.query(
      `INSERT INTO event_analysis_result
         (aice_id, event_key, lang, model_name, model,
          severity_score, likelihood_score, priority_tier,
          analysis_text, redaction_policy_version,
          requested_by)
       VALUES ('aice-defaults', 1, 'ENGLISH', 'openai', 'gpt-4o',
               0.5, 0.5, 'LOW',
               'x', 'engine:1.0.0|ranges:empty',
               gen_random_uuid())`,
    );
    const { rows: types } = await pool.query<{
      sev: string;
      lik: string;
      ttp: string;
    }>(
      `SELECT jsonb_typeof(severity_factors) AS sev,
              jsonb_typeof(likelihood_factors) AS lik,
              jsonb_typeof(ttp_tags) AS ttp
       FROM event_analysis_result
       WHERE aice_id = 'aice-defaults' AND event_key = 1`,
    );
    expect(types[0]).toEqual({ sev: "array", lik: "array", ttp: "array" });
  });

  it("rejects out-of-enum priority_tier via the CHECK constraint", async () => {
    await expect(
      pool.query(
        `INSERT INTO event_analysis_result
           (aice_id, event_key, lang, model_name, model,
            severity_score, likelihood_score, priority_tier,
            analysis_text, redaction_policy_version,
            requested_by)
         VALUES ('aice-r-check', 1, 'ENGLISH', 'openai', 'gpt-4o',
                 0.5, 0.5, 'EXTREME',
                 'x', 'engine:1.0.0|ranges:empty',
                 gen_random_uuid())`,
      ),
    ).rejects.toThrow();
  });

  it("creates the sweeper-supporting indexes added by 0004", async () => {
    // Retention sweep walks each clock column on every tick and the
    // map cascade joins through source_aice_id; without these
    // indexes the sweep becomes a sequence of seq-scans.
    const { rows } = await pool.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes
        WHERE schemaname = 'public'
          AND indexname IN (
            'idx_baseline_event_received_at',
            'idx_story_received_at',
            'idx_policy_run_received_at',
            'idx_baseline_event_source_aice_id_event_key',
            'idx_story_source_aice_id',
            'idx_policy_run_source_aice_id'
          )
        ORDER BY indexname`,
    );
    expect(rows.map((r) => r.indexname)).toEqual([
      "idx_baseline_event_received_at",
      "idx_baseline_event_source_aice_id_event_key",
      "idx_policy_run_received_at",
      "idx_policy_run_source_aice_id",
      "idx_story_received_at",
      "idx_story_source_aice_id",
    ]);
  });

  // -- Representative inserts --

  describe("representative inserts", () => {
    it("accepts a baseline_event row", async () => {
      await pool.query(
        `INSERT INTO baseline_event (
          baseline_version, event_key, event_time, kind, category,
          primary_asset, raw_score, selector_tags, raw_event,
          score_window_context, window_signals, asset_context,
          scoring_weights_snapshot, source_aice_id
        ) VALUES (
          'v1', 12345, NOW(), 'dns', 'recon',
          'host-1', 0.75, ARRAY['t1','t2']::TEXT[], '{"foo":"bar"}'::jsonb,
          '{"baseline_rank_snapshot":0.9}'::jsonb,
          '{"s1":1,"s3":2,"s4":3}'::jsonb, '{"peer_event_summary":{}}'::jsonb,
          '{"weights":{}}'::jsonb, 'aice-1'
        )`,
      );

      const { rows } = await pool.query(
        "SELECT event_key::text AS event_key FROM baseline_event WHERE baseline_version = 'v1'",
      );
      expect(rows[0].event_key).toBe("12345");
    });

    it("supports event_key-only joins via baseline_event_event_key_idx", async () => {
      // Insert two rows with the same event_key but different baseline_versions
      // — the standalone event_key index must permit this lookup.
      await pool.query(
        `INSERT INTO baseline_event (
          baseline_version, event_key, event_time, kind,
          raw_score, raw_event, score_window_context, window_signals,
          scoring_weights_snapshot, source_aice_id
        ) VALUES
          ('v-a', 99, NOW(), 'http', 0.1, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, 'aice'),
          ('v-b', 99, NOW(), 'http', 0.2, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, 'aice')`,
      );
      const { rows } = await pool.query(
        "SELECT COUNT(*)::int AS c FROM baseline_event WHERE event_key = 99",
      );
      expect(rows[0].c).toBe(2);
    });

    it("accepts a story and its story_member rows", async () => {
      await pool.query(
        `INSERT INTO story (
          story_id, story_version, kind, primary_asset,
          time_window_start, time_window_end, score,
          summary_payload, source_aice_id
        ) VALUES (
          1, 's1', 'auto_correlated', 'asset-1',
          NOW(), NOW(), 0.5,
          '{}'::jsonb, 'aice-1'
        )`,
      );

      await pool.query(
        `INSERT INTO story_member (
          story_id, story_version, member_event_key, role, event
        ) VALUES (1, 's1', 100, 'primary', '{}'::jsonb)`,
      );

      const { rows } = await pool.query(
        "SELECT role FROM story_member WHERE story_id = 1 AND story_version = 's1'",
      );
      expect(rows[0].role).toBe("primary");
    });

    it("rejects story.kind outside the allowed set", async () => {
      await expect(
        pool.query(
          `INSERT INTO story (
            story_id, story_version, kind,
            time_window_start, time_window_end,
            summary_payload, source_aice_id
          ) VALUES (
            2, 's1', 'invalid_kind',
            NOW(), NOW(),
            '{}'::jsonb, 'aice-1'
          )`,
        ),
      ).rejects.toThrow();
    });

    it("rejects story_member.role outside the allowed set", async () => {
      await pool.query(
        `INSERT INTO story (
          story_id, story_version, kind,
          time_window_start, time_window_end,
          summary_payload, source_aice_id
        ) VALUES (
          3, 's1', 'analyst_curated',
          NOW(), NOW(),
          '{}'::jsonb, 'aice'
        )`,
      );
      await expect(
        pool.query(
          `INSERT INTO story_member (
            story_id, story_version, member_event_key, role, event
          ) VALUES (3, 's1', 1, 'invalid_role', '{}'::jsonb)`,
        ),
      ).rejects.toThrow();
    });

    it("accepts a policy_run and policy_event row", async () => {
      await pool.query(
        `INSERT INTO policy_run (
          run_id, period_start, period_end, created_at_source,
          baseline_version, policies_fingerprint, exclusions_fingerprint,
          status, source_aice_id
        ) VALUES (
          10, NOW(), NOW(), NOW(),
          'v1', 'pfp', 'efp',
          'ready', 'aice-1'
        )`,
      );
      await pool.query(
        `INSERT INTO policy_event (
          run_id, event_key, event_time, kind, sensor,
          orig_addr, orig_port, resp_addr, resp_port, proto,
          host, dns_query, uri, category,
          policy_triage_snapshot
        ) VALUES (
          10, 200, NOW(), 'http', 'sensor-1',
          '10.0.0.1'::inet, 1234, '10.0.0.2'::inet, 80, 6,
          'example.com', NULL, '/x', 'recon',
          '[{"policyId":"p1","score":0.5}]'::jsonb
        )`,
      );
      const { rows } = await pool.query(
        "SELECT event_key::text AS event_key FROM policy_event WHERE run_id = 10",
      );
      expect(rows[0].event_key).toBe("200");
    });

    it("rejects policy_run.status outside the allowed set", async () => {
      await expect(
        pool.query(
          `INSERT INTO policy_run (
            run_id, period_start, period_end, created_at_source,
            baseline_version, policies_fingerprint, exclusions_fingerprint,
            status, source_aice_id
          ) VALUES (
            11, NOW(), NOW(), NOW(),
            'v1', 'p', 'e', 'invalid', 'aice'
          )`,
        ),
      ).rejects.toThrow();
    });

    it("accepts varied summary_stats shapes (no sub-shape enforced)", async () => {
      // Per RFC 0002 §11 / issue #216: the DB intentionally does NOT
      // enforce a sub-shape on summary_stats.
      const shapes: Array<Record<string, unknown> | null> = [
        null,
        {},
        { total_events: 1 },
        {
          event_count: 100,
          policy_breakdown: [{ policy_id: "p1", count: 10, score_sum: 1.5 }],
          kind_breakdown: [{ kind: "http", count: 50 }],
          category_breakdown: [{ category: "recon", count: 20 }],
        },
      ];
      for (let i = 0; i < shapes.length; i++) {
        await pool.query(
          `INSERT INTO policy_run (
            run_id, period_start, period_end, created_at_source,
            baseline_version, policies_fingerprint, exclusions_fingerprint,
            status, summary_stats, source_aice_id
          ) VALUES (
            $1, NOW(), NOW(), NOW(),
            'v1', 'p', 'e', 'ready', $2::jsonb, 'aice'
          )`,
          [1000 + i, shapes[i] === null ? null : JSON.stringify(shapes[i])],
        );
      }
    });
  });

  // -- FK cascades + soft references --

  describe("FK cascade behavior", () => {
    it("deletes story_member rows when their story is deleted", async () => {
      await pool.query(
        `INSERT INTO story (
          story_id, story_version, kind,
          time_window_start, time_window_end,
          summary_payload, source_aice_id
        ) VALUES (
          50, 's1', 'auto_correlated',
          NOW(), NOW(),
          '{}'::jsonb, 'aice'
        )`,
      );
      await pool.query(
        `INSERT INTO story_member (
          story_id, story_version, member_event_key, role, event
        ) VALUES
          (50, 's1', 1, 'primary', '{}'::jsonb),
          (50, 's1', 2, 'context', '{}'::jsonb)`,
      );

      await pool.query(
        "DELETE FROM story WHERE story_id = 50 AND story_version = 's1'",
      );

      const { rows } = await pool.query(
        "SELECT COUNT(*)::int AS c FROM story_member WHERE story_id = 50",
      );
      expect(rows[0].c).toBe(0);
    });

    it("deletes policy_event rows when their policy_run is deleted", async () => {
      await pool.query(
        `INSERT INTO policy_run (
          run_id, period_start, period_end, created_at_source,
          baseline_version, policies_fingerprint, exclusions_fingerprint,
          status, source_aice_id
        ) VALUES (
          60, NOW(), NOW(), NOW(),
          'v1', 'p', 'e', 'ready', 'aice'
        )`,
      );
      await pool.query(
        `INSERT INTO policy_event (
          run_id, event_key, event_time, kind,
          policy_triage_snapshot
        ) VALUES
          (60, 1, NOW(), 'http', '[]'::jsonb),
          (60, 2, NOW(), 'dns', '[]'::jsonb)`,
      );

      await pool.query("DELETE FROM policy_run WHERE run_id = 60");

      const { rows } = await pool.query(
        "SELECT COUNT(*)::int AS c FROM policy_event WHERE run_id = 60",
      );
      expect(rows[0].c).toBe(0);
    });

    it("policy_run.replaces is a soft reference (no FK) — referenced run can be deleted", async () => {
      await pool.query(
        `INSERT INTO policy_run (
          run_id, period_start, period_end, created_at_source,
          baseline_version, policies_fingerprint, exclusions_fingerprint,
          status, source_aice_id
        ) VALUES (
          70, NOW(), NOW(), NOW(),
          'v1', 'p', 'e', 'superseded', 'aice'
        )`,
      );
      await pool.query(
        `INSERT INTO policy_run (
          run_id, period_start, period_end, created_at_source,
          baseline_version, policies_fingerprint, exclusions_fingerprint,
          status, replaces, source_aice_id
        ) VALUES (
          71, NOW(), NOW(), NOW(),
          'v1', 'p', 'e', 'ready', 70, 'aice'
        )`,
      );

      // Deleting the referenced run must succeed (no FK to enforce).
      await pool.query("DELETE FROM policy_run WHERE run_id = 70");

      // The dangling replaces value remains as-is.
      const { rows } = await pool.query(
        "SELECT replaces FROM policy_run WHERE run_id = 71",
      );
      expect(rows[0].replaces).toBe("70");
    });
  });

  // -- aimer_customer role grants --

  describe("aimer_customer role grants", () => {
    let rolePool: Pool;

    beforeAll(async () => {
      // Ensure the runtime role exists in this test DB cluster and can
      // connect / use the public schema. Re-grant the per-table
      // privileges (the migration's GRANT statements already ran as
      // superuser; we're just confirming via a separate connection).
      await pool.query(`
        DO $$ BEGIN
          IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'aimer_customer') THEN
            CREATE ROLE aimer_customer LOGIN PASSWORD 'changeme';
          END IF;
        END $$
      `);
      await pool.query(`GRANT CONNECT ON DATABASE ${dbName} TO aimer_customer`);
      await pool.query("GRANT USAGE ON SCHEMA public TO aimer_customer");

      rolePool = createRolePool(dbName, "aimer_customer", "changeme");
    });

    afterAll(async () => {
      rolePool.on("error", () => {});
      await rolePool.end();
    });

    const phase2Tables = [
      "baseline_event",
      "story",
      "story_member",
      "policy_run",
      "policy_event",
    ];

    it("can SELECT on all Phase 2 tables", async () => {
      for (const table of phase2Tables) {
        const { rows } = await rolePool.query(`SELECT COUNT(*) FROM ${table}`);
        expect(Number(rows[0].count)).toBeGreaterThanOrEqual(0);
      }
    });

    it("can INSERT and DELETE on every Phase 2 table", async () => {
      // INSERT order respects FK dependencies: story before story_member,
      // policy_run before policy_event. DELETE walks the children first
      // so each child-table DELETE grant is exercised directly (not via
      // ON DELETE CASCADE from the parent).

      await rolePool.query(
        `INSERT INTO baseline_event (
          baseline_version, event_key, event_time, kind,
          raw_score, raw_event, score_window_context, window_signals,
          scoring_weights_snapshot, source_aice_id
        ) VALUES (
          'role-test', 1, NOW(), 'http',
          0.1, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, 'aice'
        )`,
      );

      await rolePool.query(
        `INSERT INTO story (
          story_id, story_version, kind,
          time_window_start, time_window_end,
          summary_payload, source_aice_id
        ) VALUES (
          900, 'role-test', 'auto_correlated',
          NOW(), NOW(),
          '{}'::jsonb, 'aice'
        )`,
      );
      await rolePool.query(
        `INSERT INTO story_member (
          story_id, story_version, member_event_key, role, event
        ) VALUES (900, 'role-test', 1, 'primary', '{}'::jsonb)`,
      );

      await rolePool.query(
        `INSERT INTO policy_run (
          run_id, period_start, period_end, created_at_source,
          baseline_version, policies_fingerprint, exclusions_fingerprint,
          status, source_aice_id
        ) VALUES (
          900, NOW(), NOW(), NOW(),
          'v1', 'p', 'e', 'ready', 'aice'
        )`,
      );
      await rolePool.query(
        `INSERT INTO policy_event (
          run_id, event_key, event_time, kind,
          policy_triage_snapshot
        ) VALUES (900, 1, NOW(), 'http', '[]'::jsonb)`,
      );

      // DELETE children directly to confirm the DELETE grant on each
      // child table (not just the cascade from the parent).
      await rolePool.query(
        "DELETE FROM story_member WHERE story_id = 900 AND story_version = 'role-test'",
      );
      await rolePool.query("DELETE FROM policy_event WHERE run_id = 900");
      await rolePool.query(
        "DELETE FROM baseline_event WHERE baseline_version = 'role-test'",
      );
      await rolePool.query(
        "DELETE FROM story WHERE story_id = 900 AND story_version = 'role-test'",
      );
      await rolePool.query("DELETE FROM policy_run WHERE run_id = 900");
    });

    // -- Redaction-job-worker column-scoped UPDATE grants (0005) --
    //
    // The worker re-stamps stale rows by issuing UPDATE against four
    // tables under aimer_customer. Grants are column-scoped so only
    // the redacted-payload columns and redaction_policy_version are
    // writable; operator-only columns stay read-only.

    it("can UPDATE worker-owned columns on detection_events, baseline_event, story_member, policy_event", async () => {
      await rolePool.query(
        `INSERT INTO detection_events
           (aice_id, event_key, redacted_event, redaction_policy_version,
            schema_version, payload_hash, source, ingested_by)
         VALUES ('aice-upd', 1, '{}'::jsonb, 'engine:1.0.0|ranges:empty',
                 '1.0', 'h', 'manual', gen_random_uuid())`,
      );
      await rolePool.query(
        `UPDATE detection_events
            SET redacted_event = '{"r":1}'::jsonb,
                redaction_policy_version = 'engine:1.0.0|ranges:abcdef012345'
          WHERE aice_id = 'aice-upd' AND event_key = 1`,
      );
      await rolePool.query(
        `DELETE FROM detection_events
          WHERE aice_id = 'aice-upd' AND event_key = 1`,
      );

      await rolePool.query(
        `INSERT INTO baseline_event (
          baseline_version, event_key, event_time, kind,
          raw_score, raw_event, score_window_context, window_signals,
          scoring_weights_snapshot, source_aice_id
        ) VALUES (
          'upd-test', 1, NOW(), 'http',
          0.1, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, 'aice-upd'
        )`,
      );
      await rolePool.query(
        `UPDATE baseline_event
            SET raw_event = '{"r":1}'::jsonb,
                redaction_policy_version = 'engine:1.0.0|ranges:abcdef012345'
          WHERE baseline_version = 'upd-test' AND event_key = 1`,
      );
      await rolePool.query(
        `DELETE FROM baseline_event WHERE baseline_version = 'upd-test'`,
      );

      await rolePool.query(
        `INSERT INTO story (
          story_id, story_version, kind,
          time_window_start, time_window_end,
          summary_payload, source_aice_id
        ) VALUES (
          901, 'upd-test', 'auto_correlated',
          NOW(), NOW(),
          '{}'::jsonb, 'aice-upd'
        )`,
      );
      await rolePool.query(
        `INSERT INTO story_member (
          story_id, story_version, member_event_key, role, event
        ) VALUES (901, 'upd-test', 1, 'primary', '{}'::jsonb)`,
      );
      await rolePool.query(
        `UPDATE story_member
            SET event = '{"r":1}'::jsonb,
                redaction_policy_version = 'engine:1.0.0|ranges:abcdef012345'
          WHERE story_id = 901 AND story_version = 'upd-test'
            AND member_event_key = 1`,
      );
      await rolePool.query(
        `DELETE FROM story_member WHERE story_id = 901 AND story_version = 'upd-test'`,
      );
      await rolePool.query(
        `DELETE FROM story WHERE story_id = 901 AND story_version = 'upd-test'`,
      );

      await rolePool.query(
        `INSERT INTO policy_run (
          run_id, period_start, period_end, created_at_source,
          baseline_version, policies_fingerprint, exclusions_fingerprint,
          status, source_aice_id
        ) VALUES (
          901, NOW(), NOW(), NOW(),
          'v1', 'p', 'e', 'ready', 'aice-upd'
        )`,
      );
      await rolePool.query(
        `INSERT INTO policy_event (
          run_id, event_key, event_time, kind,
          policy_triage_snapshot
        ) VALUES (901, 1, NOW(), 'http', '[]'::jsonb)`,
      );
      await rolePool.query(
        `UPDATE policy_event
            SET orig_addr = '<<REDACTED_IP_001>>',
                resp_addr = '<<REDACTED_IP_002>>',
                host = NULL, dns_query = NULL, uri = NULL,
                policy_triage_snapshot = '[]'::jsonb,
                redaction_policy_version = 'engine:1.0.0|ranges:abcdef012345'
          WHERE run_id = 901 AND event_key = 1`,
      );
      await rolePool.query(`DELETE FROM policy_event WHERE run_id = 901`);
      await rolePool.query(`DELETE FROM policy_run WHERE run_id = 901`);
    });

    it("cannot UPDATE operator-only columns on the worker-owned tables", async () => {
      // Column-scoped grant must not bleed into operator-only columns
      // (PKs, source_aice_id, raw_score, kind, role, schema_version,
      // payload_hash, source, ingested_by, etc.).
      const operatorOnlyUpdates: Array<{ sql: string; label: string }> = [
        {
          label: "detection_events.schema_version",
          sql: "UPDATE detection_events SET schema_version = 'x' WHERE false",
        },
        {
          label: "baseline_event.raw_score",
          sql: "UPDATE baseline_event SET raw_score = 0 WHERE false",
        },
        {
          label: "story_member.role",
          sql: "UPDATE story_member SET role = 'context' WHERE false",
        },
        {
          label: "policy_event.kind",
          sql: "UPDATE policy_event SET kind = 'dns' WHERE false",
        },
      ];
      for (const { sql } of operatorOnlyUpdates) {
        await expect(rolePool.query(sql)).rejects.toThrow(/permission denied/);
      }
    });

    it("cannot UPDATE the all-read-only Phase 2 tables (story, policy_run)", async () => {
      // These two were never written by the redaction job worker
      // and remain SELECT/INSERT/DELETE only via aimer_customer.
      // analysis_narrative was dropped in 0005.
      const readOnlyForUpdate: Record<string, string> = {
        story: "source_aice_id",
        policy_run: "source_aice_id",
      };
      for (const [table, col] of Object.entries(readOnlyForUpdate)) {
        await expect(
          rolePool.query(`UPDATE ${table} SET ${col} = 'x' WHERE false`),
        ).rejects.toThrow(/permission denied/);
      }
    });

    // -- Redaction foundation tables (SELECT/INSERT/UPDATE/DELETE) --

    it("can SELECT/INSERT/UPDATE/DELETE on event_redaction_map", async () => {
      await rolePool.query(
        `INSERT INTO event_redaction_map
           (aice_id, event_key, ciphertext, wrapped_dek)
         VALUES ('aice-grant', 1, decode('00', 'hex'), 'wrap-v1')`,
      );

      // UPDATE is required: shared-map invariant uses INSERT ... ON
      // CONFLICT DO UPDATE, and KEK rotation issues raw UPDATEs.
      await rolePool.query(
        `UPDATE event_redaction_map SET wrapped_dek = 'wrap-v2'
         WHERE aice_id = 'aice-grant' AND event_key = 1`,
      );

      const { rows } = await rolePool.query<{ wrapped_dek: string }>(
        `SELECT wrapped_dek FROM event_redaction_map
         WHERE aice_id = 'aice-grant' AND event_key = 1`,
      );
      expect(rows[0].wrapped_dek).toBe("wrap-v2");

      await rolePool.query(
        `DELETE FROM event_redaction_map
         WHERE aice_id = 'aice-grant' AND event_key = 1`,
      );
    });

    it("can DELETE on detection_events (added by 0004)", async () => {
      // The Phase 1 grant was SELECT/INSERT only — retention sweeper
      // requires DELETE. Without 0004 this fails with
      // "permission denied for table detection_events".
      await rolePool.query(
        `INSERT INTO detection_events
           (aice_id, event_key, redacted_event, redaction_policy_version,
            schema_version, payload_hash, source, ingested_by)
         VALUES ('aice-del', 1, '{}'::jsonb, 'engine:1.0.0|ranges:empty',
                 '1.0', 'h', 'manual', gen_random_uuid())`,
      );
      await rolePool.query(
        `DELETE FROM detection_events
         WHERE aice_id = 'aice-del' AND event_key = 1`,
      );
    });

    it("can SELECT/INSERT/UPDATE/DELETE on event_analysis_result", async () => {
      // UPDATE rights cover force=true re-analysis (UPSERT) and any
      // direct UPDATE the retroactive job needs to stamp the
      // redaction_policy_version.
      await rolePool.query(
        `INSERT INTO event_analysis_result
           (aice_id, event_key, lang, model_name, model,
            severity_score, likelihood_score, priority_tier,
            analysis_text, redaction_policy_version,
            requested_by)
         VALUES ('aice-ar', 1, 'ENGLISH', 'openai', 'gpt-4o',
                 0.5, 0.5, 'LOW',
                 'narr', 'engine:1.0.0|ranges:empty',
                 gen_random_uuid())`,
      );

      await rolePool.query(
        `UPDATE event_analysis_result SET analysis_text = 'updated'
         WHERE aice_id = 'aice-ar' AND event_key = 1
           AND lang = 'ENGLISH' AND model_name = 'openai' AND model = 'gpt-4o'`,
      );

      const { rows } = await rolePool.query<{ analysis_text: string }>(
        `SELECT analysis_text FROM event_analysis_result
         WHERE aice_id = 'aice-ar' AND event_key = 1
           AND lang = 'ENGLISH' AND model_name = 'openai' AND model = 'gpt-4o'`,
      );
      expect(rows[0].analysis_text).toBe("updated");

      await rolePool.query(
        `DELETE FROM event_analysis_result
         WHERE aice_id = 'aice-ar' AND event_key = 1
           AND lang = 'ENGLISH' AND model_name = 'openai' AND model = 'gpt-4o'`,
      );
    });

    it("can SELECT/INSERT/UPDATE/DELETE on story_analysis_result and periodic_report_result (#294 grants)", async () => {
      // Round-10 review item 3: explicit grant exercise for the new
      // RFC 0002 Phase 0 result tables. Phase 1 / Phase 2 workers run
      // under aimer_customer; a missing GRANT here would only surface
      // when the real worker landed, well after #294 merged.
      const customerId = "00000000-0000-0000-0000-00000000abcd";
      await rolePool.query(
        `INSERT INTO story_analysis_result
           (customer_id, story_id, lang, model_name, model,
            model_actual_version, prompt_version, generation,
            severity_score, likelihood_score, priority_tier,
            analysis_text, input_event_refs, input_hash,
            redaction_policy_version, requested_by)
         VALUES ($1, 9001, 'ENGLISH', 'openai', 'gpt-4o',
                 'v1', 'p1', 1,
                 0.5, 0.4, 'LOW',
                 'narr', '[]'::jsonb, 'h',
                 'engine:1.0.0|ranges:empty', gen_random_uuid())`,
        [customerId],
      );
      await rolePool.query(
        `UPDATE story_analysis_result SET analysis_text = 'updated'
          WHERE customer_id = $1 AND story_id = 9001
            AND lang = 'ENGLISH' AND model_name = 'openai'
            AND model = 'gpt-4o' AND generation = 1`,
        [customerId],
      );
      await rolePool.query(
        `DELETE FROM story_analysis_result
          WHERE customer_id = $1 AND story_id = 9001`,
        [customerId],
      );

      await rolePool.query(
        `INSERT INTO periodic_report_result
           (customer_id, period, bucket_date, tz,
            lang, model_name, model,
            model_actual_version, prompt_version, generation,
            aggregate_severity_score, aggregate_likelihood_score,
            priority_tier, sections_jsonb,
            input_event_refs, input_story_refs, input_hash,
            redaction_policy_version, requested_by)
         VALUES ($1, 'DAILY', DATE '2026-01-01', 'Asia/Seoul',
                 'ENGLISH', 'openai', 'gpt-4o',
                 'v1', 'p1', 1,
                 0.5, 0.4, 'LOW', '{}'::jsonb,
                 '[]'::jsonb, '[]'::jsonb, 'h',
                 'engine:1.0.0|ranges:empty', gen_random_uuid())`,
        [customerId],
      );
      await rolePool.query(
        `UPDATE periodic_report_result SET priority_tier = 'MEDIUM'
          WHERE customer_id = $1 AND period = 'DAILY'
            AND bucket_date = DATE '2026-01-01' AND tz = 'Asia/Seoul'
            AND lang = 'ENGLISH' AND model_name = 'openai'
            AND model = 'gpt-4o' AND generation = 1`,
        [customerId],
      );
      await rolePool.query(
        `DELETE FROM periodic_report_result WHERE customer_id = $1`,
        [customerId],
      );
    });
  });
});
