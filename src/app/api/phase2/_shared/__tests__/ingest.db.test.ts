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
import { buildRangeSet } from "@/lib/redaction";

vi.mock("server-only", () => ({}));

// Bypass OpenBao Transit by stubbing the envelope adapter — the
// redaction map is round-tripped as plaintext JSON for the test so DB
// behaviour is exercised without requiring a running Transit instance.
vi.mock("@/lib/redaction/envelope-adapter", () => ({
  encryptRedactionMap: async (_customerId: string, map: unknown) => ({
    ciphertext: Buffer.from(JSON.stringify(map), "utf8"),
    wrappedDek: "test-wrap",
  }),
  decryptRedactionMap: async (_customerId: string, ciphertext: Buffer) =>
    JSON.parse(ciphertext.toString("utf8")),
}));

const {
  ingestBaselineBatch: _ingestBaselineBatch,
  ingestPolicyRun: _ingestPolicyRun,
  ingestStoryBatch: _ingestStoryBatch,
} = await import("../ingest");
const { storyBatchSchema } = await import("../schemas");

const CUSTOMER_MIGRATIONS_DIR = join(process.cwd(), "migrations", "customer");
const LOCK_ID_CUSTOMER = 1002;

const TEST_CUSTOMER_ID = "11111111-2222-3333-4444-555555555555";
const TEST_RANGES = buildRangeSet([]);

const ingestBaselineBatch: (
  pool: Pool,
  payload: Parameters<typeof _ingestBaselineBatch>[1],
  aiceId: string,
) => ReturnType<typeof _ingestBaselineBatch> = (pool, payload, aiceId) =>
  _ingestBaselineBatch(pool, payload, TEST_CUSTOMER_ID, aiceId, TEST_RANGES);

const ingestStoryBatch: (
  pool: Pool,
  payload: Parameters<typeof _ingestStoryBatch>[1],
  aiceId: string,
) => ReturnType<typeof _ingestStoryBatch> = (pool, payload, aiceId) =>
  _ingestStoryBatch(pool, payload, TEST_CUSTOMER_ID, aiceId, TEST_RANGES);

const ingestPolicyRun: (
  pool: Pool,
  payload: Parameters<typeof _ingestPolicyRun>[1],
  aiceId: string,
) => ReturnType<typeof _ingestPolicyRun> = (pool, payload, aiceId) =>
  _ingestPolicyRun(pool, payload, TEST_CUSTOMER_ID, aiceId, TEST_RANGES);

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
      expect(first.accepted).toBe(2);
      expect(first.duplicatesSkipped).toBe(0);

      const second = await ingestBaselineBatch(pool, payload, "aice-1");
      expect(second.accepted).toBe(0);
      expect(second.duplicatesSkipped).toBe(2);
      // Duplicates-only batch produces no accepted arrivals.
      expect(second.acceptedEvents).toEqual([]);

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
      expect(mixed.accepted).toBe(1);
      expect(mixed.duplicatesSkipped).toBe(1);
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
            known_ioc_hit: false,
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

    it("round-trips known_ioc_hit=true to the story column (#330)", async () => {
      const payload = {
        external_key: "ext-1",
        source_aice_id: "aice-1",
        stories: [
          {
            story_id: "5200",
            story_version: "v1",
            kind: "auto_correlated" as const,
            time_window: {
              start: "2026-01-02T03:00:00Z",
              end: "2026-01-02T03:10:00Z",
            },
            summary_payload: {},
            known_ioc_hit: true,
            members: [],
          },
        ],
      };
      await ingestStoryBatch(pool, payload, "aice-1");
      const { rows } = await pool.query<{ known_ioc_hit: boolean }>(
        "SELECT known_ioc_hit FROM story WHERE story_id = 5200",
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].known_ioc_hit).toBe(true);
    });

    it("defaults known_ioc_hit to false when omitted from the payload (#330)", async () => {
      // Wire shape: `known_ioc_hit` absent. Parse via the schema so the
      // default-true wiring of the producer is exercised against the
      // post-parse payload (matches the production handler path).
      const payload = storyBatchSchema.parse({
        external_key: "ext-1",
        source_aice_id: "aice-1",
        stories: [
          {
            story_id: "5201",
            story_version: "v1",
            kind: "auto_correlated",
            time_window: {
              start: "2026-01-02T03:00:00Z",
              end: "2026-01-02T03:10:00Z",
            },
            summary_payload: {},
            members: [],
          },
        ],
      });
      await ingestStoryBatch(pool, payload, "aice-1");
      const { rows } = await pool.query<{ known_ioc_hit: boolean }>(
        "SELECT known_ioc_hit FROM story WHERE story_id = 5201",
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].known_ioc_hit).toBe(false);
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
            known_ioc_hit: false,
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
            known_ioc_hit: false,
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

  // -- map-write rule cross-cutting cases (RFC 0001 §"map-write rule") --

  describe("event_redaction_map write rule", () => {
    function baselinePayload(
      version: string,
      eventKey: string,
      rawEvent: Record<string, unknown>,
    ) {
      return {
        external_key: "ext-1",
        source_aice_id: "aice-2",
        baseline_version: version,
        events: [
          {
            event_key: eventKey,
            event_time: "2026-01-02T03:04:05Z",
            kind: "dns",
            category: null,
            primary_asset: null,
            raw_score: 0.5,
            selector_tags: [],
            raw_event: rawEvent,
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
        ],
      };
    }

    it("creates a map row on first write even when the event has zero redactable entities", async () => {
      const payload = baselinePayload("be-empty", "9001", { note: "nothing" });
      await ingestBaselineBatch(pool, payload, "aice-2");

      const { rows } = await pool.query<{ c: number }>(
        `SELECT COUNT(*)::int AS c FROM event_redaction_map
         WHERE aice_id = 'aice-2' AND event_key = 9001`,
      );
      expect(rows[0].c).toBe(1);
    });

    it("a same-path duplicate ingest does NOT advance updated_at on the map row", async () => {
      const payload = baselinePayload("be-dup", "9002", { note: "nothing" });
      await ingestBaselineBatch(pool, payload, "aice-2");

      const before = await pool.query<{ updated_at: Date }>(
        `SELECT updated_at FROM event_redaction_map
         WHERE aice_id = 'aice-2' AND event_key = 9002`,
      );
      expect(before.rows).toHaveLength(1);

      // Replaying the same batch: the referent INSERT no-ops on
      // (baseline_version, event_key); existing !== null AND
      // mapChanged=false, so neither map-write clause fires.
      await new Promise((resolve) => setTimeout(resolve, 20));
      await ingestBaselineBatch(pool, payload, "aice-2");

      const after = await pool.query<{ updated_at: Date }>(
        `SELECT updated_at FROM event_redaction_map
         WHERE aice_id = 'aice-2' AND event_key = 9002`,
      );
      expect(after.rows[0].updated_at.toISOString()).toBe(
        before.rows[0].updated_at.toISOString(),
      );
    });

    it("cross-path ingest that adds a new entity UPSERTs the map and advances updated_at", async () => {
      // First write: one IP entity.
      const first = baselinePayload("be-cross-1", "9003", {
        src: "10.0.0.1",
      });
      await ingestBaselineBatch(pool, first, "aice-2");

      const beforeMap = await pool.query<{
        ciphertext: Buffer;
        updated_at: Date;
      }>(
        `SELECT ciphertext, updated_at FROM event_redaction_map
         WHERE aice_id = 'aice-2' AND event_key = 9003`,
      );
      const beforeEntities = Object.values(
        JSON.parse(beforeMap.rows[0].ciphertext.toString("utf8")) as Record<
          string,
          { value: string }
        >,
      ).map((e) => e.value);
      expect(beforeEntities).toContain("10.0.0.1");

      // Second write: same (aice_id, event_key) via a Phase 2 path
      // (different referent row — baseline_version differs — so the
      // referent inserts; the map row pre-exists). Add a second entity.
      await new Promise((resolve) => setTimeout(resolve, 20));
      const second = baselinePayload("be-cross-2", "9003", {
        src: "10.0.0.1",
        also: "user@example.com",
      });
      await ingestBaselineBatch(pool, second, "aice-2");

      const afterMap = await pool.query<{
        ciphertext: Buffer;
        updated_at: Date;
      }>(
        `SELECT ciphertext, updated_at FROM event_redaction_map
         WHERE aice_id = 'aice-2' AND event_key = 9003`,
      );
      const afterEntities = Object.values(
        JSON.parse(afterMap.rows[0].ciphertext.toString("utf8")) as Record<
          string,
          { value: string }
        >,
      ).map((e) => e.value);
      expect(afterEntities).toContain("10.0.0.1");
      expect(afterEntities).toContain("user@example.com");
      expect(afterMap.rows[0].updated_at.getTime()).toBeGreaterThan(
        beforeMap.rows[0].updated_at.getTime(),
      );
    });
  });

  // -- policy_event TEXT column writes (no `::inet` cast) --

  describe("policy_event redacted IP columns", () => {
    it("writes redacted IP tokens into orig_addr/resp_addr as TEXT", async () => {
      const runPayload = {
        external_key: "ext-1",
        run: {
          run_id: "7100",
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
            orig_addr: "10.0.0.5",
            resp_addr: "192.168.1.10",
            host: "internal.example.com",
            policy_triage_snapshot: [],
          },
        ],
      };
      await ingestPolicyRun(pool, runPayload, "aice-pol");

      const { rows } = await pool.query<{
        orig_addr: string | null;
        resp_addr: string | null;
      }>(
        "SELECT orig_addr, resp_addr FROM policy_event WHERE run_id = 7100 AND event_key = 1",
      );
      expect(rows).toHaveLength(1);
      // Tokens land verbatim — `::inet` cast would have rejected them
      // ("invalid input syntax for type inet") so a row's existence
      // here is the load-bearing assertion. Token format is asserted
      // for clarity.
      expect(rows[0].orig_addr).toMatch(/^<<REDACTED_IP_\d{3}>>$/);
      expect(rows[0].resp_addr).toMatch(/^<<REDACTED_IP_\d{3}>>$/);
    });
  });

  // -- cross-path Phase 1 ↔ Phase 2 concurrency on the advisory lock --

  describe("cross-path concurrency", () => {
    it("Phase 2 ingest racing the same (aice_id, event_key) reuses the earlier writer's tokens", async () => {
      // We can't reach `storeApprovedEvents` directly (it needs an
      // auth_db pool + decrypted payload pipeline); instead we model
      // the race at the map-write primitive layer, which is the only
      // shared concurrency point. Both writers go through
      // `readMapWithLock`/`writeMap` (Phase 1 and all Phase 2 sites do).
      const { readMapWithLock, writeMap } = await import(
        "@/lib/redaction/map-write"
      );
      const { withTransaction } = await import("@/lib/db/client");

      const aiceId = "aice-cross";
      const eventKey = "8001";

      // T1 (simulates Phase 1 approve): acquires lock, writes one IP
      // entity, holds the transaction so T2 must wait.
      let t1Committed = false;
      const t1 = (async () => {
        await withTransaction(pool, async (client) => {
          await readMapWithLock(
            client as Parameters<typeof readMapWithLock>[0],
            TEST_CUSTOMER_ID,
            aiceId,
            eventKey,
          );
          await writeMap(
            client as Parameters<typeof writeMap>[0],
            TEST_CUSTOMER_ID,
            aiceId,
            eventKey,
            {
              "<<REDACTED_IP_001>>": { kind: "ip", value: "10.0.0.7" },
            },
          );
          await new Promise((resolve) => setTimeout(resolve, 150));
          t1Committed = true;
        });
      })();

      // Give T1 time to take the lock.
      await new Promise((resolve) => setTimeout(resolve, 25));

      // T2 (simulates Phase 2 ingest of same logical event): blocks
      // on the advisory lock, then sees T1's map. It adds a second
      // entity using the engine and writes a UPSERT — the resulting
      // map carries both entities with no orphans.
      let t2ObservedT1Commit = false;
      const t2 = (async () => {
        const { redact, ENGINE_VERSION, buildRangeSet } = await import(
          "@/lib/redaction"
        );
        await withTransaction(pool, async (client) => {
          const existing = await readMapWithLock(
            client as Parameters<typeof readMapWithLock>[0],
            TEST_CUSTOMER_ID,
            aiceId,
            eventKey,
          );
          t2ObservedT1Commit = t1Committed;
          expect(existing).toEqual({
            "<<REDACTED_IP_001>>": { kind: "ip", value: "10.0.0.7" },
          });

          // Engine merge: existing IP reused, a new email added.
          const out = redact({
            payload: { a: "10.0.0.7", b: "user@example.com" },
            existingMap: existing ?? {},
            ranges: buildRangeSet([]),
            engineVersion: ENGINE_VERSION,
          });
          expect(out.mapChanged).toBe(true);
          await writeMap(
            client as Parameters<typeof writeMap>[0],
            TEST_CUSTOMER_ID,
            aiceId,
            eventKey,
            out.mergedMap,
          );
        });
      })();

      await Promise.all([t1, t2]);
      expect(t2ObservedT1Commit).toBe(true);

      // Final map: both entities present, IP token unchanged, email
      // appended as a new token. No duplicate tokens, no orphan values.
      const { rows } = await pool.query<{ ciphertext: Buffer }>(
        `SELECT ciphertext FROM event_redaction_map
         WHERE aice_id = $1 AND event_key = $2::numeric`,
        [aiceId, eventKey],
      );
      const map = JSON.parse(rows[0].ciphertext.toString("utf8")) as Record<
        string,
        { kind: string; value: string }
      >;
      expect(map["<<REDACTED_IP_001>>"]).toEqual({
        kind: "ip",
        value: "10.0.0.7",
      });
      const emailEntries = Object.entries(map).filter(
        ([, e]) => e.kind === "email",
      );
      expect(emailEntries).toHaveLength(1);
      expect(emailEntries[0][1].value).toBe("user@example.com");
      const values = Object.values(map).map((e) => e.value);
      expect(new Set(values).size).toBe(values.length);
    });
  });
});
