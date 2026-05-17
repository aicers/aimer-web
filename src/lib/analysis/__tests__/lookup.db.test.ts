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
import { lookupAnalysisForEvent, lookupAnalysisNarrative } from "../lookup";

const CUSTOMER_MIGRATIONS_DIR = join(process.cwd(), "migrations", "customer");
const LOCK_ID_CUSTOMER = 1002;

async function insertBaseline(
  pool: Pool,
  baselineVersion: string,
  eventKey: string,
  receivedAt: string,
  overrides: Partial<{ kind: string; category: string }> = {},
): Promise<void> {
  await pool.query(
    `INSERT INTO baseline_event (
       baseline_version, event_key, event_time, kind, category,
       raw_score, raw_event, score_window_context, window_signals,
       scoring_weights_snapshot, source_aice_id, received_at
     ) VALUES (
       $1, $2::numeric, NOW(), $3, $4,
       0.5, '{"r":1}'::jsonb, '{"baseline_rank_snapshot":0.9}'::jsonb, '{}'::jsonb,
       '{}'::jsonb, 'aice-1', $5::timestamptz
     )`,
    [
      baselineVersion,
      eventKey,
      overrides.kind ?? "http",
      overrides.category ?? null,
      receivedAt,
    ],
  );
}

describe.skipIf(!hasPostgres)("Phase 2 analysis lookup helpers", () => {
  let dbName: string;
  let pool: Pool;

  beforeAll(async () => {
    const db = await createTestDatabase("analysis_lookup");
    dbName = db.dbName;
    pool = db.pool;
    await runMigrations(pool, CUSTOMER_MIGRATIONS_DIR, LOCK_ID_CUSTOMER);
  });

  afterAll(async () => {
    await dropTestDatabase(dbName, pool);
    await closeAdminPool();
  });

  describe("lookupAnalysisForEvent", () => {
    it("returns the Phase 2 row when baseline_event has a match", async () => {
      await insertBaseline(pool, "be-v1", "1001", "2026-01-02T03:00:00Z", {
        kind: "dns",
        category: "recon",
      });

      const result = await lookupAnalysisForEvent(pool, "1001");
      expect(result.source).toBe("phase2");
      if (result.source !== "phase2") return;
      expect(result.row.event_key).toBe("1001");
      expect(result.row.baseline_version).toBe("be-v1");
      expect(result.row.kind).toBe("dns");
      expect(result.row.category).toBe("recon");
      expect(result.row.raw_score).toBe(0.5);
      // JSONB columns surface as parsed objects from node-postgres.
      expect(result.row.raw_event).toEqual({ r: 1 });
      // received_at is returned as a JS Date by node-postgres.
      expect(result.row.received_at).toBeInstanceOf(Date);
    });

    it("returns { source: 'none' } when no baseline_event row matches", async () => {
      const result = await lookupAnalysisForEvent(pool, "9999999999");
      expect(result).toEqual({ source: "none" });
    });

    it("returns the most recent by received_at when multiple baseline_versions share the same event_key", async () => {
      // Same event_key under three baseline_versions — read helper must
      // pick the row with the latest received_at, NOT assume 1:1
      // mapping (per #216 schema note).
      await insertBaseline(pool, "ver-a", "2002", "2026-02-01T00:00:00Z");
      await insertBaseline(pool, "ver-b", "2002", "2026-02-03T00:00:00Z");
      await insertBaseline(pool, "ver-c", "2002", "2026-02-02T00:00:00Z");

      const result = await lookupAnalysisForEvent(pool, "2002");
      expect(result.source).toBe("phase2");
      if (result.source !== "phase2") return;
      expect(result.row.baseline_version).toBe("ver-b");
    });

    it("returns { source: 'none' } even when only a Phase 1 detection_events row would exist (v1 limitation)", async () => {
      // This test documents the v1 limitation per issue #220: aimer-web
      // does NOT search detection_events by event_key (encrypted BYTEA
      // without a plaintext event_key index). The lookup is Phase 2
      // only. We simulate the absence by asserting that a fresh
      // event_key with no baseline_event row returns "none" — there is
      // no detection_events.event_key column to seed in the first place.
      const result = await lookupAnalysisForEvent(pool, "424242");
      expect(result).toEqual({ source: "none" });
    });
  });

  describe("lookupAnalysisNarrative", () => {
    it("returns null when no narrative row matches", async () => {
      const result = await lookupAnalysisNarrative(pool, "story", {
        story_id: "8000",
        story_version: "v1",
      });
      expect(result).toBeNull();
    });

    it("returns the row when a narrative exists for the (target_kind, target_keys) pair", async () => {
      await pool.query(
        `INSERT INTO analysis_narrative (
           content_hash, target_kind, target_keys, narrative,
           prompt_version, model_version
         ) VALUES (
           'hash-story-1', 'story',
           '{"story_id":"8001","story_version":"v1"}'::jsonb,
           'a narrative',
           'p-v1', 'm-v1'
         )`,
      );

      const result = await lookupAnalysisNarrative(pool, "story", {
        story_id: "8001",
        story_version: "v1",
      });
      expect(result).not.toBeNull();
      if (result === null) return;
      expect(result.content_hash).toBe("hash-story-1");
      expect(result.narrative).toBe("a narrative");
      expect(result.prompt_version).toBe("p-v1");
      expect(result.model_version).toBe("m-v1");
      expect(result.target_keys).toEqual({
        story_id: "8001",
        story_version: "v1",
      });
    });

    it("returns the most recent by generated_at when multiple narratives exist for the same target", async () => {
      // Two narratives for the same story, generated under different
      // prompt/model versions — helper must return the most recent.
      await pool.query(
        `INSERT INTO analysis_narrative (
           content_hash, target_kind, target_keys, narrative,
           prompt_version, model_version, generated_at
         ) VALUES (
           'hash-story-old', 'story',
           '{"story_id":"8100","story_version":"v1"}'::jsonb,
           'old narrative',
           'p-v1', 'm-v1', '2026-01-01T00:00:00Z'
         )`,
      );
      await pool.query(
        `INSERT INTO analysis_narrative (
           content_hash, target_kind, target_keys, narrative,
           prompt_version, model_version, generated_at
         ) VALUES (
           'hash-story-new', 'story',
           '{"story_id":"8100","story_version":"v1"}'::jsonb,
           'new narrative',
           'p-v2', 'm-v2', '2026-03-01T00:00:00Z'
         )`,
      );

      const result = await lookupAnalysisNarrative(pool, "story", {
        story_id: "8100",
        story_version: "v1",
      });
      expect(result?.content_hash).toBe("hash-story-new");
      expect(result?.prompt_version).toBe("p-v2");
    });

    it("distinguishes narratives across target_kind values with overlapping target_keys", async () => {
      // story_id 9000 vs run_id 9000 — same numeric value, different
      // target_kind. Equality on (target_kind, target_keys) must keep
      // them separate.
      await pool.query(
        `INSERT INTO analysis_narrative (
           content_hash, target_kind, target_keys, narrative,
           prompt_version, model_version
         ) VALUES
           ('hash-story-9000', 'story',
            '{"story_id":"9000","story_version":"v1"}'::jsonb,
            'story narrative', 'p', 'm'),
           ('hash-run-9000', 'policy_run',
            '{"run_id":"9000"}'::jsonb,
            'run narrative', 'p', 'm')`,
      );

      const storyResult = await lookupAnalysisNarrative(pool, "story", {
        story_id: "9000",
        story_version: "v1",
      });
      expect(storyResult?.content_hash).toBe("hash-story-9000");

      const runResult = await lookupAnalysisNarrative(pool, "policy_run", {
        run_id: "9000",
      });
      expect(runResult?.content_hash).toBe("hash-run-9000");
    });

    it("supports baseline_event narrative lookup by (baseline_version, event_key)", async () => {
      await pool.query(
        `INSERT INTO analysis_narrative (
           content_hash, target_kind, target_keys, narrative,
           prompt_version, model_version
         ) VALUES (
           'hash-be-1', 'baseline_event',
           '{"baseline_version":"v1","event_key":"1234567890"}'::jsonb,
           'baseline event narrative',
           'p', 'm'
         )`,
      );

      const result = await lookupAnalysisNarrative(pool, "baseline_event", {
        baseline_version: "v1",
        event_key: "1234567890",
      });
      expect(result?.content_hash).toBe("hash-be-1");
    });

    it("returns null when target_keys shape matches but values differ", async () => {
      // Confirms JSONB equality, not partial match.
      await pool.query(
        `INSERT INTO analysis_narrative (
           content_hash, target_kind, target_keys, narrative,
           prompt_version, model_version
         ) VALUES (
           'hash-policy-7', 'policy_run',
           '{"run_id":"7"}'::jsonb,
           'n', 'p', 'm'
         )`,
      );

      const miss = await lookupAnalysisNarrative(pool, "policy_run", {
        run_id: "8",
      });
      expect(miss).toBeNull();
    });
  });
});
