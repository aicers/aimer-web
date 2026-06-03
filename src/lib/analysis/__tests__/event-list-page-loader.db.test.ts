// WS3 (#392) — Suspicious Events list loader DB tests (customer-DB keyset).
//
// Exercises `queryEventListPage` directly against a real customer pool:
//   - canonical variant resolution: one row per (aice_id, event_key) — the
//     latest generation of the default variant that is not superseded; the
//     KOREAN (non-default) variant is ignored
//   - priority-first ordering via the integer rank, with every tiebreak
//     direction pinned (severity, likelihood, requested_at DESC; aice_id,
//     event_key ASC)
//   - priority-tier and time-window filters
//   - keyset pagination yields every row exactly once, in order, no gaps

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
vi.mock("@/lib/auth/cookies", () => ({ getAuthCookie: vi.fn() }));
vi.mock("@/lib/auth/jwt", () => ({ verifyJwtFull: vi.fn() }));
vi.mock("@/lib/auth/session-policy", () => ({ getSessionPolicy: vi.fn() }));
vi.mock("@/lib/auth/session-validator", () => ({ validateSession: vi.fn() }));
vi.mock("@/lib/auth/authorization", () => ({ authorize: vi.fn() }));

const { queryEventListPage } = await import("../event-list-page-loader");

const CUSTOMER_MIGRATIONS_DIR = join(process.cwd(), "migrations", "customer");
const CUSTOMER_LOCK_ID = 3702;
const REQUESTER = "00000000-0000-0000-0000-0000000000aa";

describe.skipIf(!hasPostgres)("event list loader (customer-DB keyset)", () => {
  let dbName: string;
  let pool: Pool;

  async function seed(args: {
    aiceId: string;
    eventKey: string;
    tier: string;
    sev: number;
    lik: number;
    requestedAt: string;
    generation?: number;
    lang?: string;
    superseded?: boolean;
  }): Promise<void> {
    await pool.query(
      `INSERT INTO event_analysis_result
         (aice_id, event_key, lang, model_name, model, generation,
          severity_score, likelihood_score, priority_tier, analysis_text,
          redaction_policy_version, requested_by, requested_at, superseded_at)
       VALUES ($1, $2::numeric, $3, 'openai', 'gpt-4o', $4,
               $5, $6, $7, 'text', 'v1', $8::uuid, $9::timestamptz,
               CASE WHEN $10::boolean THEN NOW() ELSE NULL END)`,
      [
        args.aiceId,
        args.eventKey,
        args.lang ?? "ENGLISH",
        args.generation ?? 1,
        args.sev,
        args.lik,
        args.tier,
        REQUESTER,
        args.requestedAt,
        args.superseded ?? false,
      ],
    );
  }

  beforeAll(async () => {
    const cust = await createTestDatabase("event_list_cust");
    dbName = cust.dbName;
    pool = cust.pool;
    await runMigrations(pool, CUSTOMER_MIGRATIONS_DIR, CUSTOMER_LOCK_ID);

    // (aiceA, 1000): gen1 superseded (LOW) + gen2 current (CRITICAL) — the
    // canonical row must be gen2.
    await seed({
      aiceId: "aiceA",
      eventKey: "1000",
      tier: "LOW",
      sev: 0.1,
      lik: 0.1,
      requestedAt: "2026-05-01T00:00:00Z",
      generation: 1,
      superseded: true,
    });
    await seed({
      aiceId: "aiceA",
      eventKey: "1000",
      tier: "CRITICAL",
      sev: 0.9,
      lik: 0.9,
      requestedAt: "2026-05-27T00:00:00Z",
      generation: 2,
    });
    await seed({
      aiceId: "aiceA",
      eventKey: "1001",
      tier: "CRITICAL",
      sev: 0.9,
      lik: 0.9,
      requestedAt: "2026-05-26T00:00:00Z",
    });
    // Cohort with identical (rank, sev, lik, requested_at) → aice_id then
    // event_key ASC tiebreak.
    await seed({
      aiceId: "aiceA",
      eventKey: "2000",
      tier: "CRITICAL",
      sev: 0.8,
      lik: 0.8,
      requestedAt: "2026-05-20T00:00:00Z",
    });
    await seed({
      aiceId: "aiceA",
      eventKey: "2001",
      tier: "CRITICAL",
      sev: 0.8,
      lik: 0.8,
      requestedAt: "2026-05-20T00:00:00Z",
    });
    await seed({
      aiceId: "aiceB",
      eventKey: "2000",
      tier: "CRITICAL",
      sev: 0.8,
      lik: 0.8,
      requestedAt: "2026-05-20T00:00:00Z",
    });
    await seed({
      aiceId: "aiceA",
      eventKey: "3000",
      tier: "HIGH",
      sev: 0.7,
      lik: 0.7,
      requestedAt: "2026-05-25T00:00:00Z",
    });
    await seed({
      aiceId: "aiceA",
      eventKey: "4000",
      tier: "LOW",
      sev: 0.1,
      lik: 0.1,
      requestedAt: "2026-05-10T00:00:00Z",
    });
    // KOREAN (non-default) variant — must be ignored.
    await seed({
      aiceId: "aiceA",
      eventKey: "5000",
      tier: "CRITICAL",
      sev: 0.99,
      lik: 0.99,
      requestedAt: "2026-05-29T00:00:00Z",
      lang: "KOREAN",
    });
  }, 30_000);

  afterAll(async () => {
    await dropTestDatabase(dbName, pool);
    await closeAdminPool();
  }, 30_000);

  const key = (i: { aiceId: string; eventKey: string }) =>
    `${i.aiceId}:${i.eventKey}`;
  const FULL_ORDER = [
    "aiceA:1000",
    "aiceA:1001",
    "aiceA:2000",
    "aiceA:2001",
    "aiceB:2000",
    "aiceA:3000",
    "aiceA:4000",
  ];

  it("resolves the canonical variant and orders priority-first", async () => {
    const page = await queryEventListPage(pool, { customerId: "x" });
    expect(page.items.map(key)).toEqual(FULL_ORDER);
    // gen2 (CRITICAL) won over the superseded gen1 (LOW) for aiceA:1000.
    expect(page.items[0].priorityTier).toBe("CRITICAL");
    // KOREAN variant is excluded.
    expect(page.items.map(key)).not.toContain("aiceA:5000");
  });

  it("returns the default variant for detail links", async () => {
    const page = await queryEventListPage(pool, { customerId: "x" });
    expect(page.variant).toEqual({
      lang: "ENGLISH",
      modelName: "openai",
      model: "gpt-4o",
    });
  });

  it("filters by priority tier", async () => {
    const page = await queryEventListPage(pool, {
      customerId: "x",
      priorityTier: "HIGH",
    });
    expect(page.items.map(key)).toEqual(["aiceA:3000"]);
  });

  it("filters by time window (requested_at lower bound)", async () => {
    const page = await queryEventListPage(pool, {
      customerId: "x",
      since: new Date("2026-05-25T00:00:00Z"),
    });
    // requested_at >= 05-25: aiceA:1000 (27), aiceA:1001 (26), aiceA:3000 (25).
    expect(page.items.map(key)).toEqual([
      "aiceA:1000",
      "aiceA:1001",
      "aiceA:3000",
    ]);
  });

  it("keyset-paginates every row exactly once, in order, no gaps", async () => {
    const collected: string[] = [];
    let cursor: string | null = null;
    for (let guard = 0; guard < 10; guard++) {
      const page = await queryEventListPage(pool, {
        customerId: "x",
        cursor,
        pageSize: 2,
      });
      collected.push(...page.items.map(key));
      cursor = page.nextCursor;
      if (!cursor) break;
    }
    expect(collected).toEqual(FULL_ORDER);
  });
});
