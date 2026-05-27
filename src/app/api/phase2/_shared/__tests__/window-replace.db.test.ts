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
  ingestStoryBatch: _ingestStoryBatch,
} = await import("../ingest");
const { executeWindowReplace: _executeWindowReplace } = await import(
  "../window-replace"
);

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

const executeWindowReplace: (
  pool: Pool,
  payload: Parameters<typeof _executeWindowReplace>[1],
  aiceId: string,
  ranges?: typeof TEST_RANGES,
) => ReturnType<typeof _executeWindowReplace> = (
  pool,
  payload,
  aiceId,
  ranges = TEST_RANGES,
) => _executeWindowReplace(pool, payload, TEST_CUSTOMER_ID, aiceId, ranges);

const CUSTOMER_MIGRATIONS_DIR = join(process.cwd(), "migrations", "customer");
const LOCK_ID_CUSTOMER = 1002;

const baselineEvent = (key: string, time: string) => ({
  event_key: key,
  event_time: time,
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
});

const story = (
  id: string,
  version: string,
  start: string,
  end: string,
  kind: "auto_correlated" | "analyst_curated" = "auto_correlated",
) => ({
  story_id: id,
  story_version: version,
  kind,
  time_window: { start, end },
  summary_payload: {},
  members: [],
});

describe.skipIf(!hasPostgres)("executeWindowReplace — baseline", () => {
  let dbName: string;
  let pool: Pool;

  beforeAll(async () => {
    const db = await createTestDatabase("phase2_window_baseline");
    dbName = db.dbName;
    pool = db.pool;
    await runMigrations(pool, CUSTOMER_MIGRATIONS_DIR, LOCK_ID_CUSTOMER);
  });
  afterAll(async () => {
    await dropTestDatabase(dbName, pool);
    await closeAdminPool();
  });

  it("DELETE filters by baseline_version — other versions preserved", async () => {
    // Two versions, same time range.
    await ingestBaselineBatch(
      pool,
      {
        external_key: "ext",
        baseline_version: "vA",
        events: [
          baselineEvent("1", "2026-02-01T00:30:00Z"),
          baselineEvent("2", "2026-02-01T00:45:00Z"),
        ],
      },
      "aice-1",
    );
    await ingestBaselineBatch(
      pool,
      {
        external_key: "ext",
        baseline_version: "vB",
        events: [baselineEvent("99", "2026-02-01T00:30:00Z")],
      },
      "aice-1",
    );

    const result = await executeWindowReplace(
      pool,
      {
        external_key: "ext",
        window: {
          kind: "baseline_event",
          from: "2026-02-01T00:00:00Z",
          to: "2026-02-01T01:00:00Z",
        },
        baseline_version: "vA",
        events: [baselineEvent("10", "2026-02-01T00:10:00Z")],
      },
      "aice-1",
    );

    expect(result.counts.accepted).toBe(1);
    expect(result.counts.deleted).toBe(2);

    const { rows: vbRows } = await pool.query(
      "SELECT event_key::text AS k FROM baseline_event WHERE baseline_version = 'vB' ORDER BY k",
    );
    expect(vbRows.map((r) => r.k)).toEqual(["99"]);

    const { rows: vaRows } = await pool.query(
      "SELECT event_key::text AS k FROM baseline_event WHERE baseline_version = 'vA' ORDER BY k",
    );
    expect(vaRows.map((r) => r.k)).toEqual(["10"]);
  });

  it("empty events array clears the window", async () => {
    await ingestBaselineBatch(
      pool,
      {
        external_key: "ext",
        baseline_version: "vClear",
        events: [
          baselineEvent("1", "2026-03-01T00:30:00Z"),
          baselineEvent("2", "2026-03-01T00:45:00Z"),
        ],
      },
      "aice-1",
    );

    const result = await executeWindowReplace(
      pool,
      {
        external_key: "ext",
        window: {
          kind: "baseline_event",
          from: "2026-03-01T00:00:00Z",
          to: "2026-03-01T01:00:00Z",
        },
        baseline_version: "vClear",
        events: [],
      },
      "aice-1",
    );

    expect(result.counts.accepted).toBe(0);
    expect(result.counts.deleted).toBe(2);

    const { rowCount } = await pool.query(
      "SELECT 1 FROM baseline_event WHERE baseline_version = 'vClear'",
    );
    expect(rowCount).toBe(0);
  });

  it("backfill-style idempotency: re-running same body produces same end state", async () => {
    const body = {
      external_key: "ext",
      window: {
        kind: "baseline_event" as const,
        from: "2026-04-01T00:00:00Z",
        to: "2026-04-01T01:00:00Z",
      },
      baseline_version: "vIdem",
      events: [
        baselineEvent("1", "2026-04-01T00:10:00Z"),
        baselineEvent("2", "2026-04-01T00:20:00Z"),
      ],
    };
    const first = await executeWindowReplace(pool, body, "aice-1");
    expect(first.counts.accepted).toBe(2);

    const second = await executeWindowReplace(pool, body, "aice-1");
    expect(second.counts.accepted).toBe(2);
    expect(second.counts.deleted).toBe(2);

    const { rows } = await pool.query(
      "SELECT event_key::text AS k FROM baseline_event WHERE baseline_version = 'vIdem' ORDER BY k",
    );
    expect(rows.map((r) => r.k)).toEqual(["1", "2"]);
  });
});

describe.skipIf(!hasPostgres)("executeWindowReplace — story", () => {
  let dbName: string;
  let pool: Pool;

  beforeAll(async () => {
    const db = await createTestDatabase("phase2_window_story");
    dbName = db.dbName;
    pool = db.pool;
    await runMigrations(pool, CUSTOMER_MIGRATIONS_DIR, LOCK_ID_CUSTOMER);
  });
  afterAll(async () => {
    await dropTestDatabase(dbName, pool);
    await closeAdminPool();
  });

  it("curated stories survive a refresh", async () => {
    await ingestStoryBatch(
      pool,
      {
        external_key: "ext",
        stories: [
          story("1", "v1", "2026-02-01T00:30:00Z", "2026-02-01T00:45:00Z"),
          story(
            "2",
            "v1",
            "2026-02-01T00:30:00Z",
            "2026-02-01T00:45:00Z",
            "analyst_curated",
          ),
        ],
      },
      "aice-1",
    );

    const result = await executeWindowReplace(
      pool,
      {
        external_key: "ext",
        window: {
          kind: "story",
          from: "2026-02-01T00:00:00Z",
          to: "2026-02-01T01:00:00Z",
        },
        stories: [
          story("3", "v1", "2026-02-01T00:10:00Z", "2026-02-01T00:20:00Z"),
        ],
      },
      "aice-1",
    );
    expect(result.counts.accepted).toBe(1);
    expect(result.counts.deleted).toBe(1); // only auto

    const { rows } = await pool.query(
      "SELECT story_id::text AS i, kind FROM story ORDER BY i",
    );
    expect(rows).toEqual([
      { i: "2", kind: "analyst_curated" },
      { i: "3", kind: "auto_correlated" },
    ]);
  });

  it("auto-correlated stories at any version are replaced (no version filter)", async () => {
    await ingestStoryBatch(
      pool,
      {
        external_key: "ext",
        stories: [
          story("10", "v1", "2026-03-01T00:10:00Z", "2026-03-01T00:20:00Z"),
          story("10", "v2", "2026-03-01T00:10:00Z", "2026-03-01T00:20:00Z"),
        ],
      },
      "aice-1",
    );

    const result = await executeWindowReplace(
      pool,
      {
        external_key: "ext",
        window: {
          kind: "story",
          from: "2026-03-01T00:00:00Z",
          to: "2026-03-01T01:00:00Z",
        },
        stories: [],
      },
      "aice-1",
    );

    expect(result.counts.deleted).toBe(2);
  });

  it("story whose start is before window survives even if end is inside (start-time assignment)", async () => {
    await ingestStoryBatch(
      pool,
      {
        external_key: "ext",
        stories: [
          // Pre-existing story: start before the window, end inside it.
          story("77", "v1", "2026-05-01T00:30:00Z", "2026-05-01T01:30:00Z"),
        ],
      },
      "aice-1",
    );

    const result = await executeWindowReplace(
      pool,
      {
        external_key: "ext",
        window: {
          kind: "story",
          from: "2026-05-01T01:00:00Z",
          to: "2026-05-01T02:00:00Z",
        },
        stories: [],
      },
      "aice-1",
    );

    expect(result.counts.deleted).toBe(0);
    const { rowCount } = await pool.query(
      "SELECT 1 FROM story WHERE story_id = 77",
    );
    expect(rowCount).toBe(1);
  });

  it("serializes concurrent same-window refreshes via the advisory lock", async () => {
    // Insert a starting state so the first DELETE returns >0 and we can
    // observe ordering by the deleted count of the second call.
    await ingestStoryBatch(
      pool,
      {
        external_key: "ext",
        stories: [
          story("200", "v1", "2026-06-01T00:30:00Z", "2026-06-01T00:40:00Z"),
        ],
      },
      "aice-1",
    );

    const body = (id: string) => ({
      external_key: "ext",
      window: {
        kind: "story" as const,
        from: "2026-06-01T00:00:00Z",
        to: "2026-06-01T01:00:00Z",
      },
      stories: [
        story(id, "v1", "2026-06-01T00:10:00Z", "2026-06-01T00:20:00Z"),
      ],
    });

    const [a, b] = await Promise.all([
      executeWindowReplace(pool, body("301"), "aice-1"),
      executeWindowReplace(pool, body("302"), "aice-1"),
    ]);

    // The two calls serialize. After both, exactly one story remains
    // in the window (the loser's INSERT followed the winner's DELETE).
    expect(a.counts.accepted).toBe(1);
    expect(b.counts.accepted).toBe(1);
    expect(a.counts.deleted + b.counts.deleted).toBeGreaterThanOrEqual(1);

    const { rows } = await pool.query(
      `SELECT story_id::text AS i FROM story
        WHERE time_window_start >= '2026-06-01T00:00:00Z'
          AND time_window_start <  '2026-06-01T01:00:00Z'
        ORDER BY i`,
    );
    // Final state: only the loser's INSERT survives (the winner's row
    // was deleted by the loser's DELETE).
    expect(rows.length).toBe(1);
    expect(["301", "302"]).toContain(rows[0].i);
  });
});

// ---------------------------------------------------------------------------
// Redaction storage parity (#322)
// ---------------------------------------------------------------------------

describe.skipIf(!hasPostgres)(
  "executeWindowReplace — redaction storage parity",
  () => {
    let dbName: string;
    let pool: Pool;
    const RANGES_WITH_DEFAULTS = buildRangeSet([]);

    beforeAll(async () => {
      const db = await createTestDatabase("phase2_window_redaction");
      dbName = db.dbName;
      pool = db.pool;
      await runMigrations(pool, CUSTOMER_MIGRATIONS_DIR, LOCK_ID_CUSTOMER);
    });
    afterAll(async () => {
      await dropTestDatabase(dbName, pool);
      await closeAdminPool();
    });

    it("baseline window-replace redacts raw_event PII and stamps redaction_policy_version", async () => {
      const event = {
        ...baselineEvent("1001", "2026-07-01T00:10:00Z"),
        raw_event: { src: "10.0.0.42", note: "hello" },
      };

      const result = await executeWindowReplace(
        pool,
        {
          external_key: "ext",
          window: {
            kind: "baseline_event",
            from: "2026-07-01T00:00:00Z",
            to: "2026-07-01T01:00:00Z",
          },
          baseline_version: "vRed",
          events: [event],
        },
        "aice-red",
        RANGES_WITH_DEFAULTS,
      );
      expect(result.counts.accepted).toBe(1);

      const { rows } = await pool.query<{
        raw_event: Record<string, unknown>;
        redaction_policy_version: string;
      }>(
        `SELECT raw_event, redaction_policy_version FROM baseline_event
          WHERE baseline_version = 'vRed' AND event_key = 1001`,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].redaction_policy_version).not.toBe("");
      // Engine produces tokens of the form <<REDACTED_IP_NNN>>.
      expect(String(rows[0].raw_event.src)).toMatch(/^<<REDACTED_IP_\d+>>$/);
      expect(rows[0].raw_event.note).toBe("hello");

      // Map row exists (RFC 0001 invariant: every ingested event has
      // one) and contains the IP entity.
      const { rows: mapRows } = await pool.query<{ ciphertext: Buffer }>(
        `SELECT ciphertext FROM event_redaction_map
          WHERE aice_id = 'aice-red' AND event_key = 1001`,
      );
      expect(mapRows).toHaveLength(1);
      const map = JSON.parse(mapRows[0].ciphertext.toString("utf8")) as Record<
        string,
        { kind: string; value: string }
      >;
      const ipEntities = Object.values(map).filter((e) => e.kind === "ip");
      expect(ipEntities.map((e) => e.value)).toContain("10.0.0.42");
    });

    it("story window-replace redacts story_member.event and stamps redaction_policy_version", async () => {
      const result = await executeWindowReplace(
        pool,
        {
          external_key: "ext",
          window: {
            kind: "story",
            from: "2026-07-02T00:00:00Z",
            to: "2026-07-02T01:00:00Z",
          },
          stories: [
            {
              ...story(
                "2001",
                "v1",
                "2026-07-02T00:10:00Z",
                "2026-07-02T00:20:00Z",
              ),
              members: [
                {
                  event_key: "2050",
                  role: "primary" as const,
                  event: { src: "10.0.0.99", host: "x" },
                },
              ],
            },
          ],
        },
        "aice-red",
        RANGES_WITH_DEFAULTS,
      );
      expect(result.counts.accepted).toBe(1);

      const { rows } = await pool.query<{
        event: Record<string, unknown>;
        redaction_policy_version: string;
      }>(
        `SELECT event, redaction_policy_version FROM story_member
          WHERE story_id = 2001 AND member_event_key = 2050`,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].redaction_policy_version).not.toBe("");
      expect(String(rows[0].event.src)).toMatch(/^<<REDACTED_IP_\d+>>$/);
      expect(rows[0].event.host).toBe("x");

      const { rows: mapRows } = await pool.query<{ ciphertext: Buffer }>(
        `SELECT ciphertext FROM event_redaction_map
          WHERE aice_id = 'aice-red' AND event_key = 2050`,
      );
      expect(mapRows).toHaveLength(1);
    });

    it("re-running window-replace on an existing (aice_id, event_key) reuses the map row (no duplicate, same tokens)", async () => {
      const baseEvent = {
        ...baselineEvent("3001", "2026-07-03T00:10:00Z"),
        raw_event: { src: "10.0.0.7" },
      };
      const body = {
        external_key: "ext",
        window: {
          kind: "baseline_event" as const,
          from: "2026-07-03T00:00:00Z",
          to: "2026-07-03T01:00:00Z",
        },
        baseline_version: "vReuse",
        events: [baseEvent],
      };

      await executeWindowReplace(
        pool,
        body,
        "aice-reuse",
        RANGES_WITH_DEFAULTS,
      );

      const firstMap = await pool.query<{
        ciphertext: Buffer;
        updated_at: Date;
      }>(
        `SELECT ciphertext, updated_at FROM event_redaction_map
          WHERE aice_id = 'aice-reuse' AND event_key = 3001`,
      );
      expect(firstMap.rows).toHaveLength(1);
      const firstTokens = Object.keys(
        JSON.parse(firstMap.rows[0].ciphertext.toString("utf8")) as Record<
          string,
          unknown
        >,
      );

      // Same payload, same window — DELETE removes the row, INSERT
      // rewrites it. The map row for (aice_id, event_key) must be
      // reused (not duplicated) and the tokens must stay stable.
      await new Promise((resolve) => setTimeout(resolve, 20));
      await executeWindowReplace(
        pool,
        body,
        "aice-reuse",
        RANGES_WITH_DEFAULTS,
      );

      const { rows: countRows } = await pool.query<{ c: number }>(
        `SELECT COUNT(*)::int AS c FROM event_redaction_map
          WHERE aice_id = 'aice-reuse' AND event_key = 3001`,
      );
      expect(countRows[0].c).toBe(1);

      const secondMap = await pool.query<{ ciphertext: Buffer }>(
        `SELECT ciphertext FROM event_redaction_map
          WHERE aice_id = 'aice-reuse' AND event_key = 3001`,
      );
      const secondTokens = Object.keys(
        JSON.parse(secondMap.rows[0].ciphertext.toString("utf8")) as Record<
          string,
          unknown
        >,
      );
      expect(secondTokens.sort()).toEqual(firstTokens.sort());

      // Referent row carries the same token its map maps to.
      const { rows: refRows } = await pool.query<{
        raw_event: Record<string, unknown>;
      }>(
        `SELECT raw_event FROM baseline_event
          WHERE baseline_version = 'vReuse' AND event_key = 3001`,
      );
      const tokenInPayload = String(refRows[0].raw_event.src);
      expect(firstTokens).toContain(tokenInPayload);
    });
  },
);
