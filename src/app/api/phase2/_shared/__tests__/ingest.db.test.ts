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

const CUSTOMER_MIGRATIONS_DIR = join(process.cwd(), "migrations", "customer");
const LOCK_ID_CUSTOMER = 1002;

describe.skipIf(!hasPostgres)("Phase 2 ingest helpers", () => {
  let dbName: string;
  let pool: Pool;

  beforeAll(async () => {
    const db = await createTestDatabase("phase2_ingest");
    dbName = db.dbName;
    pool = db.pool;
    await runMigrations(pool, CUSTOMER_MIGRATIONS_DIR, LOCK_ID_CUSTOMER);
  });

  afterAll(async () => {
    await dropTestDatabase(dbName, pool);
    await closeAdminPool();
  });

  // -- baseline --

  describe("ingestBaselineBatch", () => {
    it("inserts new rows and skips duplicates on (baseline_version, event_key)", async () => {
      const payload = {
        external_key: "ext-1",
        source_aice_id: "aice-1",
        baseline_version: "be-v1",
        events: [
          {
            event_key: "1001",
            event_time: "2026-01-02T03:04:05Z",
            kind: "dns",
            category: "recon",
            primary_asset: "host-1",
            raw_score: 0.5,
            selector_tags: ["t1"],
            raw_event: {},
            score_window_context: {
              kind_cohort_window: {
                from: "2026-01-01T00:00:00Z",
                to: "2026-01-02T00:00:00Z",
              },
              kind_cohort_size: 128,
              baseline_rank_snapshot: 0.9,
            },
            window_signals: {},
            asset_context: null,
            scoring_weights_snapshot: {},
          },
          {
            event_key: "1002",
            event_time: "2026-01-02T03:04:06Z",
            kind: "http",
            category: null,
            primary_asset: null,
            raw_score: 0.6,
            selector_tags: [],
            raw_event: {},
            score_window_context: {
              kind_cohort_window: {
                from: "2026-01-01T00:00:00Z",
                to: "2026-01-02T00:00:00Z",
              },
              kind_cohort_size: 128,
              baseline_rank_snapshot: 0.9,
            },
            window_signals: {},
            scoring_weights_snapshot: {},
          },
        ],
      };

      const first = await ingestBaselineBatch(pool, payload, "aice-1");
      expect(first).toEqual({ accepted: 2, duplicatesSkipped: 0 });

      const second = await ingestBaselineBatch(pool, payload, "aice-1");
      expect(second).toEqual({ accepted: 0, duplicatesSkipped: 2 });

      // Mixed batch: one new + one duplicate.
      const mixed = await ingestBaselineBatch(
        pool,
        {
          ...payload,
          events: [
            payload.events[0],
            {
              ...payload.events[1],
              event_key: "1003",
            },
          ],
        },
        "aice-1",
      );
      expect(mixed).toEqual({ accepted: 1, duplicatesSkipped: 1 });
    });
  });

  // -- story --

  describe("ingestStoryBatch", () => {
    it("inserts story + members and recovers from partial prior INSERT", async () => {
      const payload = {
        external_key: "ext-1",
        source_aice_id: "aice-1",
        stories: [
          {
            story_id: "5001",
            story_version: "v1",
            kind: "auto_correlated" as const,
            time_window: {
              start: "2026-01-02T03:00:00Z",
              end: "2026-01-02T03:10:00Z",
            },
            score: 0.7,
            summary_payload: {},
            members: [
              {
                event_key: "1",
                role: "primary" as const,
                event: {},
              },
              {
                event_key: "2",
                role: "context" as const,
                event: {},
              },
            ],
          },
        ],
      };

      const first = await ingestStoryBatch(pool, payload, "aice-1");
      expect(first.storiesAccepted).toBe(1);
      expect(first.membersAccepted).toBe(2);

      // Simulate partial prior INSERT: delete one member, replay batch.
      await pool.query(
        "DELETE FROM story_member WHERE story_id = 5001 AND member_event_key = 2",
      );

      const replay = await ingestStoryBatch(pool, payload, "aice-1");
      // Story is a duplicate; one member is new (the deleted one), one is dup.
      expect(replay.storiesAccepted).toBe(0);
      expect(replay.storiesDuplicates).toBe(1);
      expect(replay.membersAccepted).toBe(1);
      expect(replay.membersDuplicates).toBe(1);
    });

    it("accepts mixed story_version values in a single batch", async () => {
      const payload = {
        external_key: "ext-1",
        stories: [
          {
            story_id: "5100",
            story_version: "v1",
            kind: "auto_correlated" as const,
            time_window: {
              start: "2026-01-02T03:00:00Z",
              end: "2026-01-02T03:10:00Z",
            },
            summary_payload: {},
            members: [],
          },
          {
            story_id: "5100",
            story_version: "v2",
            kind: "analyst_curated" as const,
            time_window: {
              start: "2026-01-02T03:00:00Z",
              end: "2026-01-02T03:10:00Z",
            },
            summary_payload: {},
            members: [],
          },
        ],
      };
      const result = await ingestStoryBatch(pool, payload, "aice-1");
      expect(result.storiesAccepted).toBe(2);
    });
  });

  // -- policy_run --

  describe("ingestPolicyRun", () => {
    it("inserts a run with events, then converges on a second call (multi-batch)", async () => {
      const runPayload = {
        external_key: "ext-1",
        run: {
          run_id: "7001",
          period_start: "2026-01-02T03:00:00Z",
          period_end: "2026-01-02T04:00:00Z",
          created_at: "2026-01-02T04:00:01Z",
          baseline_version: "pr-v1",
          policies_fingerprint: "pfp",
          exclusions_fingerprint: "efp",
          status: "ready" as const,
        },
        events: [
          {
            event_key: "1",
            event_time: "2026-01-02T03:05:00Z",
            kind: "http",
            policy_triage_snapshot: [],
          },
          {
            event_key: "2",
            event_time: "2026-01-02T03:06:00Z",
            kind: "dns",
            policy_triage_snapshot: [],
          },
        ],
      };

      const first = await ingestPolicyRun(pool, runPayload, "aice-1");
      expect(first).toEqual({
        accepted: 2,
        duplicatesSkipped: 0,
        runStatus: "new",
      });

      // Second batch for same run: one duplicate event + one new event.
      const second = await ingestPolicyRun(
        pool,
        {
          ...runPayload,
          events: [
            runPayload.events[1],
            {
              event_key: "3",
              event_time: "2026-01-02T03:07:00Z",
              kind: "ftp",
              policy_triage_snapshot: [],
            },
          ],
        },
        "aice-1",
      );
      expect(second).toEqual({
        accepted: 1,
        duplicatesSkipped: 1,
        runStatus: "duplicate",
      });

      const { rows } = await pool.query(
        "SELECT COUNT(*)::int AS c FROM policy_event WHERE run_id = 7001",
      );
      expect(rows[0].c).toBe(3);
    });
  });
});
