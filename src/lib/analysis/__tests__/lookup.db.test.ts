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
  type AnalysisLookupResult,
  type BaselineEventRow,
  lookupAnalysisForEvent,
} from "../lookup";

const CUSTOMER_MIGRATIONS_DIR = join(process.cwd(), "migrations", "customer");
const LOCK_ID_CUSTOMER = 1002;

async function insertBaselineRow(
  pool: Pool,
  opts: {
    baseline_version: string;
    event_key: string;
    received_at: string;
    event_time?: string;
    kind?: string;
    category?: string | null;
    primary_asset?: string | null;
    raw_score?: number;
    selector_tags?: string[];
    raw_event?: Record<string, unknown>;
    score_window_context?: Record<string, unknown>;
    window_signals?: Record<string, unknown>;
    asset_context?: Record<string, unknown> | null;
    scoring_weights_snapshot?: Record<string, unknown>;
    source_aice_id?: string;
  },
): Promise<void> {
  await pool.query(
    `INSERT INTO baseline_event (
       baseline_version, event_key, event_time, kind, category,
       primary_asset, raw_score, selector_tags, raw_event,
       score_window_context, window_signals, asset_context,
       scoring_weights_snapshot, source_aice_id, received_at
     ) VALUES (
       $1, $2::numeric, $3, $4, $5,
       $6, $7, $8, $9::jsonb,
       $10::jsonb, $11::jsonb, $12::jsonb,
       $13::jsonb, $14, $15
     )`,
    [
      opts.baseline_version,
      opts.event_key,
      opts.event_time ?? "2026-01-01T00:00:00Z",
      opts.kind ?? "dns",
      opts.category ?? null,
      opts.primary_asset ?? null,
      opts.raw_score ?? 0.5,
      opts.selector_tags ?? [],
      JSON.stringify(opts.raw_event ?? {}),
      JSON.stringify(opts.score_window_context ?? {}),
      JSON.stringify(opts.window_signals ?? {}),
      opts.asset_context == null ? null : JSON.stringify(opts.asset_context),
      JSON.stringify(opts.scoring_weights_snapshot ?? {}),
      opts.source_aice_id ?? "aice-1",
      opts.received_at,
    ],
  );
}

describe.skipIf(!hasPostgres)("lookupAnalysisForEvent", () => {
  let dbName: string;
  let pool: Pool;

  beforeAll(async () => {
    const db = await createTestDatabase("analysis_lookup_event");
    dbName = db.dbName;
    pool = db.pool;
    await runMigrations(pool, CUSTOMER_MIGRATIONS_DIR, LOCK_ID_CUSTOMER);
  });

  afterAll(async () => {
    await dropTestDatabase(dbName, pool);
    await closeAdminPool();
  });

  it("returns { source: 'phase2', row } when a baseline_event row exists", async () => {
    await insertBaselineRow(pool, {
      baseline_version: "vA",
      event_key: "1001",
      received_at: "2026-02-01T00:00:00Z",
      event_time: "2026-01-15T12:00:00Z",
      kind: "http",
      category: "exfil",
      primary_asset: "host-7",
      raw_score: 0.91,
      selector_tags: ["alpha", "beta"],
      raw_event: { hello: "world" },
      asset_context: { owner: "team-x" },
    });

    const result = await lookupAnalysisForEvent(pool, "1001");
    expect(result.source).toBe("phase2");
    if (result.source !== "phase2") throw new Error("unreachable");
    const row: BaselineEventRow = result.row;
    expect(row.event_key).toBe("1001");
    expect(row.baseline_version).toBe("vA");
    expect(row.kind).toBe("http");
    expect(row.category).toBe("exfil");
    expect(row.primary_asset).toBe("host-7");
    expect(row.raw_score).toBeCloseTo(0.91);
    expect(row.selector_tags).toEqual(["alpha", "beta"]);
    expect(row.raw_event).toEqual({ hello: "world" });
    expect(row.asset_context).toEqual({ owner: "team-x" });
    expect(row.event_time).toBeInstanceOf(Date);
    expect(row.received_at).toBeInstanceOf(Date);
  });

  it("returns { source: 'none' } when no baseline_event row matches", async () => {
    const result: AnalysisLookupResult = await lookupAnalysisForEvent(
      pool,
      "9999999999",
    );
    expect(result).toEqual({ source: "none" });
  });

  it("returns { source: 'none' } for a Phase 1 detection_events row (v1 limitation)", async () => {
    // v1 limitation case: `lookupAnalysisForEvent` queries baseline_event
    // only. A Phase 1 detection_events row carries event_key as a
    // plaintext NUMERIC column after the #250 schema refactor, but the
    // helper still does not search it — the Phase 2 row remains the
    // canonical analysis row by design (RFC 0002 §8). This test ensures
    // a detection_events row with a matching event_key is NOT promoted
    // to a `phase2` match.
    await pool.query(
      `INSERT INTO detection_events
         (aice_id, event_key, redacted_event, redaction_policy_version,
          schema_version, payload_hash, source, ingested_by)
       VALUES
         ('aice-1', 4242, '{"hello":"world"}'::jsonb, 'engine:1.0.0|ranges:empty',
          'v1', 'hash', 'manual',
          '00000000-0000-0000-0000-000000000001')`,
    );

    const result = await lookupAnalysisForEvent(pool, "4242");
    expect(result).toEqual({ source: "none" });
  });

  it("picks the most recent baseline_event by received_at across baseline_versions", async () => {
    await insertBaselineRow(pool, {
      baseline_version: "vOld",
      event_key: "2002",
      received_at: "2026-03-01T00:00:00Z",
      kind: "old-kind",
    });
    await insertBaselineRow(pool, {
      baseline_version: "vNew",
      event_key: "2002",
      received_at: "2026-03-02T00:00:00Z",
      kind: "new-kind",
    });

    const result = await lookupAnalysisForEvent(pool, "2002");
    expect(result.source).toBe("phase2");
    if (result.source !== "phase2") throw new Error("unreachable");
    expect(result.row.baseline_version).toBe("vNew");
    expect(result.row.kind).toBe("new-kind");
  });

  it("breaks received_at ties with baseline_version DESC for determinism", async () => {
    const tiedAt = "2026-04-01T00:00:00Z";
    await insertBaselineRow(pool, {
      baseline_version: "vAA",
      event_key: "3003",
      received_at: tiedAt,
      kind: "from-vAA",
    });
    await insertBaselineRow(pool, {
      baseline_version: "vZZ",
      event_key: "3003",
      received_at: tiedAt,
      kind: "from-vZZ",
    });

    const result = await lookupAnalysisForEvent(pool, "3003");
    expect(result.source).toBe("phase2");
    if (result.source !== "phase2") throw new Error("unreachable");
    // Textual DESC: "vZZ" > "vAA".
    expect(result.row.baseline_version).toBe("vZZ");
    expect(result.row.kind).toBe("from-vZZ");
  });

  it("does not leak analysis_narrative — the table does not exist", async () => {
    // Sanity check the RFC 0001 retirement: the legacy table must not
    // exist. Source of truth for the cache is event_analysis_result.
    const { rows } = await pool.query(
      `SELECT to_regclass('public.analysis_narrative') AS table_oid`,
    );
    expect(rows[0].table_oid).toBeNull();
  });
});
