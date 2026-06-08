// Customer-DB integration test for the event-leaf backfill universe /
// drain SQL (#470). Validates that the scope query agrees with the
// report-builder event-time basis (latest baseline_event event_time, the
// same dedupe order `selectTopEvents` uses) and that the per-member
// already_current / source_present flags are computed correctly against a
// real customer schema.

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

vi.mock("server-only", () => ({}));

const { loadUniverse, planBackfill } = await import("../event-leaf-backfill");
const { computeEventLeafDrain } = await import("../event-leaf-drain");

const CUSTOMER_MIGRATIONS_DIR = join(process.cwd(), "migrations", "customer");
const LOCK_ID = 4700;
const AICE = "aice-1";

const TARGET = { lang: "ENGLISH", modelName: "openai", model: "gpt-5.5" };
// Window [2026-06-01, 2026-06-08); in-window events sit at 2026-06-05.
const WINDOW = {
  windowStart: new Date("2026-06-01T00:00:00.000Z"),
  windowEnd: new Date("2026-06-08T00:00:00.000Z"),
};
const IN_WINDOW = "2026-06-05T00:00:00Z";
const OUT_OF_WINDOW = "2026-05-01T00:00:00Z";

describe.skipIf(!hasPostgres)("event-leaf backfill universe (db)", () => {
  let dbName: string;
  let pool: Pool;

  async function seedBaseline(eventKey: string, eventTime: string) {
    await pool.query(
      `INSERT INTO baseline_event
         (baseline_version, event_key, event_time, kind, category, raw_score,
          raw_event, score_window_context, window_signals,
          scoring_weights_snapshot, source_aice_id, received_at)
       VALUES ('vA', $1::numeric, $2::timestamptz, 'k', 'recon', 0.5,
               '{}'::jsonb, '{}'::jsonb, '{}'::jsonb,
               '{}'::jsonb, $3, $2::timestamptz)`,
      [eventKey, eventTime, AICE],
    );
  }

  async function seedLeaf(
    eventKey: string,
    model: string,
    opts: { superseded?: boolean; generation?: number } = {},
  ) {
    await pool.query(
      `INSERT INTO event_analysis_result
         (aice_id, event_key, lang, model_name, model,
          model_actual_version, prompt_version, generation,
          severity_score, likelihood_score,
          severity_factors, likelihood_factors, ttp_tags,
          priority_tier, analysis_text, redaction_policy_version,
          requested_by, superseded_at)
       VALUES ($1, $2::numeric, 'ENGLISH', 'openai', $3,
               'mv', 'pv', $4, 0.5, 0.5,
               '[]'::jsonb, '[]'::jsonb, '[]'::jsonb,
               'MEDIUM', 'text', 'policy-A', gen_random_uuid(),
               $5::timestamptz)`,
      [
        AICE,
        eventKey,
        model,
        opts.generation ?? 1,
        opts.superseded ? IN_WINDOW : null,
      ],
    );
  }

  async function seedDetection(eventKey: string) {
    await pool.query(
      `INSERT INTO detection_events
         (aice_id, event_key, redacted_event, redaction_policy_version,
          schema_version, payload_hash, source, ingested_by)
       VALUES ($1, $2::numeric, '{}'::jsonb, 'policy-A', 'v1', 'h',
               'bridge', gen_random_uuid())`,
      [AICE, eventKey],
    );
  }

  beforeAll(async () => {
    const cust = await createTestDatabase("event_universe_cust");
    dbName = cust.dbName;
    pool = cust.pool;
    await runMigrations(pool, CUSTOMER_MIGRATIONS_DIR, LOCK_ID);

    // A: in-window, old-model leaf only, source present → work candidate.
    await seedBaseline("1001", IN_WINDOW);
    await seedLeaf("1001", "gpt-4o");
    await seedDetection("1001");

    // B: in-window, TARGET-model leaf non-superseded → already_current.
    await seedBaseline("1002", IN_WINDOW);
    await seedLeaf("1002", "gpt-5.5");
    await seedDetection("1002");

    // C: in-window, old-model leaf, NO detection_events → source_unavailable.
    await seedBaseline("1003", IN_WINDOW);
    await seedLeaf("1003", "gpt-4o");

    // D: OUT of window → excluded from the universe entirely.
    await seedBaseline("1004", OUT_OF_WINDOW);
    await seedLeaf("1004", "gpt-4o");
    await seedDetection("1004");

    // E: in-window, a SUPERSEDED target leaf + a live old-model leaf →
    // work candidate (a superseded target leaf is NOT already_current).
    await seedBaseline("1005", IN_WINDOW);
    await seedLeaf("1005", "gpt-5.5", { superseded: true, generation: 1 });
    await seedLeaf("1005", "gpt-4o", { generation: 1 });
    await seedDetection("1005");
  });

  afterAll(async () => {
    await dropTestDatabase(dbName, pool);
    await closeAdminPool();
  });

  it("selects the in-window existing-leaf universe with correct flags", async () => {
    const members = await loadUniverse(pool, WINDOW, TARGET);
    const byKey = new Map(members.map((m) => [m.eventKey, m]));
    // D (out of window) is excluded.
    expect(byKey.has("1004")).toBe(false);
    expect(members).toHaveLength(4);

    expect(byKey.get("1001")).toMatchObject({
      alreadyCurrent: false,
      sourcePresent: true,
    });
    expect(byKey.get("1002")).toMatchObject({ alreadyCurrent: true });
    expect(byKey.get("1003")).toMatchObject({
      alreadyCurrent: false,
      sourcePresent: false,
    });
    expect(byKey.get("1005")).toMatchObject({
      alreadyCurrent: false,
      sourcePresent: true,
    });
  });

  it("plans the no-silent-caps categories from the universe", async () => {
    const members = await loadUniverse(pool, WINDOW, TARGET);
    const { counts, workItems } = planBackfill(members, null);
    expect(counts.totalUniverse).toBe(4);
    expect(counts.alreadyCurrent).toBe(1); // B
    expect(counts.sourceUnavailable).toBe(1); // C
    expect(counts.reanalyze).toBe(2); // A + E
    const keys = workItems.map((w) => w.eventKey).sort();
    expect(keys).toEqual(["1001", "1005"]);
  });

  it("reports drain outstanding for work candidates, excluding source_unavailable", async () => {
    const status = await computeEventLeafDrain(pool, {
      customerId: "c-1",
      windowDays: 7,
      target: TARGET,
      now: WINDOW.windowEnd,
    });
    expect(status.kind).toBe("event");
    expect(status.universe).toBe(4);
    expect(status.outstanding).toBe(2); // A + E
    expect(status.sourceUnavailable).toBe(1); // C
    expect(status.drained).toBe(false);
  });

  it("is drained once the work candidates gain a target leaf", async () => {
    // Give A and E a non-superseded target-variant leaf.
    await seedLeaf("1001", "gpt-5.5", { generation: 2 });
    await seedLeaf("1005", "gpt-5.5", { generation: 2 });
    const status = await computeEventLeafDrain(pool, {
      customerId: "c-1",
      windowDays: 7,
      target: TARGET,
      now: WINDOW.windowEnd,
    });
    // Only the source_unavailable event (C) remains, and it is excluded
    // from outstanding — so the scope is drained.
    expect(status.outstanding).toBe(0);
    expect(status.drained).toBe(true);
  });
});
