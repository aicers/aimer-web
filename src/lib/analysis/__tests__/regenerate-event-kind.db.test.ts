// #552 — regenerate kind carry-forward.
//
// Exercises `recoverCarriedForwardKind` directly against a real customer pool.
// The event-level `kind` must survive re-analysis: a newer / higher-generation
// manual or regenerated row stores `kind = NULL`, but it must NOT shadow an
// older auto-baseline row that carried a real kind. The helper recovers the
// latest row whose `kind IS NOT NULL`, and returns `null` only when no prior
// row ever carried one.

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

const { recoverCarriedForwardKind } = await import("../regenerate-event");

const CUSTOMER_MIGRATIONS_DIR = join(process.cwd(), "migrations", "customer");
const CUSTOMER_LOCK_ID = 3705;
const REQUESTER = "00000000-0000-0000-0000-0000000000aa";

describe.skipIf(!hasPostgres)("regenerate kind carry-forward (#552)", () => {
  let dbName: string;
  let pool: Pool;

  async function seed(args: {
    aiceId: string;
    eventKey: string;
    generation: number;
    requestedAt: string;
    kind: string | null;
  }): Promise<void> {
    await pool.query(
      `INSERT INTO event_analysis_result
         (aice_id, event_key, lang, model_name, model,
          model_actual_version, prompt_version,
          severity_score, likelihood_score, priority_tier, analysis_text,
          event_time, kind,
          redaction_policy_version, requested_by, requested_at, generation)
       VALUES ($1, $2::numeric, 'ENGLISH', 'openai', 'gpt-4o',
               'mv', 'pv',
               0.5, 0.5, 'LOW', 'text',
               '2026-05-20T00:00:00Z'::timestamptz, $5,
               'v1', $6::uuid, $3::timestamptz, $4)`,
      [
        args.aiceId,
        args.eventKey,
        args.requestedAt,
        args.generation,
        args.kind,
        REQUESTER,
      ],
    );
  }

  beforeAll(async () => {
    const cust = await createTestDatabase("regen_kind_cust");
    dbName = cust.dbName;
    pool = cust.pool;
    await runMigrations(pool, CUSTOMER_MIGRATIONS_DIR, CUSTOMER_LOCK_ID);
  }, 30_000);

  afterAll(async () => {
    await dropTestDatabase(dbName, pool);
    await closeAdminPool();
  }, 30_000);

  it("carries forward an older non-null kind past a newer null row", async () => {
    // Older auto-baseline row carries the kind; a newer, higher-generation
    // manual/regenerated row stores NULL. The NULL row must not win.
    await seed({
      aiceId: "aiceA",
      eventKey: "1000",
      generation: 1,
      requestedAt: "2026-05-01T00:00:00Z",
      kind: "HttpThreat",
    });
    await seed({
      aiceId: "aiceA",
      eventKey: "1000",
      generation: 2,
      requestedAt: "2026-05-02T00:00:00Z",
      kind: null,
    });

    expect(await recoverCarriedForwardKind(pool, "aiceA", "1000")).toBe(
      "HttpThreat",
    );
  });

  it("returns null when no prior row ever carried a kind", async () => {
    await seed({
      aiceId: "aiceB",
      eventKey: "2000",
      generation: 1,
      requestedAt: "2026-05-01T00:00:00Z",
      kind: null,
    });

    expect(await recoverCarriedForwardKind(pool, "aiceB", "2000")).toBeNull();
  });

  it("returns null when the event has no prior rows", async () => {
    expect(await recoverCarriedForwardKind(pool, "aiceMissing", "9999")).toBe(
      null,
    );
  });

  it("picks the most recent non-null kind among several", async () => {
    await seed({
      aiceId: "aiceC",
      eventKey: "3000",
      generation: 1,
      requestedAt: "2026-05-01T00:00:00Z",
      kind: "BlocklistHttp",
    });
    await seed({
      aiceId: "aiceC",
      eventKey: "3000",
      generation: 2,
      requestedAt: "2026-05-05T00:00:00Z",
      kind: "HttpThreat",
    });
    await seed({
      aiceId: "aiceC",
      eventKey: "3000",
      generation: 3,
      requestedAt: "2026-05-09T00:00:00Z",
      kind: null,
    });

    expect(await recoverCarriedForwardKind(pool, "aiceC", "3000")).toBe(
      "HttpThreat",
    );
  });
});
