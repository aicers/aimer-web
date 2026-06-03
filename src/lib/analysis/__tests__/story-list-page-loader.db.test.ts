// WS3 (#392) — Threat Stories list loader DB tests (auth-DB keyset path).
//
// Exercises `queryStoryListPage` directly against a real auth pool:
//   - priority-first ordering via the integer rank (NOT the raw text), with
//     every tiebreak direction pinned (severity, likelihood, recency DESC;
//     story_id ASC)
//   - excludes archived rows and pending rows (NULL priority)
//   - the recency tiebreak falls back to updated_at when last_ready_at IS NULL
//   - priority-tier and time-window filters
//   - keyset pagination yields every row exactly once, in order, no gaps
//
// The auth preamble (cookie/JWT/session/authorize) is covered by the page
// unit test; here the auth modules are stubbed so the module imports cleanly
// and we call the exported query path with a test pool.

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

const { queryStoryListPage } = await import("../story-list-page-loader");

const AUTH_MIGRATIONS_DIR = join(process.cwd(), "migrations", "auth");
const AUTH_LOCK_ID = 3701;
const CUSTOMER_ID = "00000000-0000-0000-0000-0000000003b1";

describe.skipIf(!hasPostgres)("story list loader (auth-DB keyset)", () => {
  let authDbName: string;
  let authPool: Pool;

  async function seed(args: {
    storyId: number;
    status: string;
    tier?: string | null;
    sev?: number | null;
    lik?: number | null;
    lastReadyAt?: string | null;
    updatedAt?: string;
  }): Promise<void> {
    await authPool.query(
      `INSERT INTO story_analysis_state
         (customer_id, story_id, status, priority_tier, severity_score,
          likelihood_score, last_ready_at, updated_at)
       VALUES ($1, $2::bigint, $3, $4, $5, $6, $7::timestamptz,
               COALESCE($8::timestamptz, NOW()))`,
      [
        CUSTOMER_ID,
        args.storyId,
        args.status,
        args.tier ?? null,
        args.sev ?? null,
        args.lik ?? null,
        args.lastReadyAt ?? null,
        args.updatedAt ?? null,
      ],
    );
  }

  beforeAll(async () => {
    const auth = await createTestDatabase("story_list_auth");
    authDbName = auth.dbName;
    authPool = auth.pool;
    await runMigrations(authPool, AUTH_MIGRATIONS_DIR, AUTH_LOCK_ID);

    await authPool.query(
      `INSERT INTO customers (id, external_key, name, database_status, timezone)
       VALUES ($1, 'sl-1', 'SL Customer', 'active', 'UTC')`,
      [CUSTOMER_ID],
    );

    // CRITICAL / sev0.9 / lik0.9 cohort, separated only by recency then id.
    await seed({
      storyId: 100,
      status: "ready",
      tier: "CRITICAL",
      sev: 0.9,
      lik: 0.9,
      lastReadyAt: "2026-05-27T00:00:00Z",
    });
    await seed({
      storyId: 101,
      status: "ready",
      tier: "CRITICAL",
      sev: 0.9,
      lik: 0.9,
      lastReadyAt: "2026-05-26T00:00:00Z",
    });
    // 200 & 201: identical recency → story_id ASC tiebreak.
    await seed({
      storyId: 200,
      status: "ready",
      tier: "CRITICAL",
      sev: 0.9,
      lik: 0.9,
      lastReadyAt: "2026-05-25T00:00:00Z",
    });
    await seed({
      storyId: 201,
      status: "ready",
      tier: "CRITICAL",
      sev: 0.9,
      lik: 0.9,
      lastReadyAt: "2026-05-25T00:00:00Z",
    });
    // Same tier+severity but lower likelihood → sorts after the cohort.
    await seed({
      storyId: 102,
      status: "ready",
      tier: "CRITICAL",
      sev: 0.9,
      lik: 0.8,
      lastReadyAt: "2026-05-28T00:00:00Z",
    });
    // HIGH cohort.
    await seed({
      storyId: 103,
      status: "ready",
      tier: "HIGH",
      sev: 0.99,
      lik: 0.99,
      lastReadyAt: "2026-05-29T00:00:00Z",
    });
    await seed({
      storyId: 104,
      status: "ready",
      tier: "HIGH",
      sev: 0.5,
      lik: 0.5,
      lastReadyAt: "2026-05-20T00:00:00Z",
    });
    // LOW + dirty, recency via updated_at fallback (last_ready_at NULL).
    await seed({
      storyId: 105,
      status: "dirty",
      tier: "LOW",
      sev: 0.1,
      lik: 0.1,
      lastReadyAt: null,
      updatedAt: "2026-05-19T00:00:00Z",
    });
    // Excluded: pending (NULL priority) and archived.
    await seed({ storyId: 106, status: "pending" });
    await seed({
      storyId: 107,
      status: "archived",
      tier: "CRITICAL",
      sev: 0.95,
      lik: 0.95,
      lastReadyAt: "2026-05-30T00:00:00Z",
    });
  }, 30_000);

  afterAll(async () => {
    await dropTestDatabase(authDbName, authPool);
    await closeAdminPool();
  }, 30_000);

  const FULL_ORDER = ["100", "101", "200", "201", "102", "103", "104", "105"];

  it("orders by priority rank then pinned tiebreaks, excluding pending/archived", async () => {
    const page = await queryStoryListPage(authPool, {
      customerId: CUSTOMER_ID,
    });
    expect(page.items.map((i) => i.storyId)).toEqual(FULL_ORDER);
    // No pending (106) or archived (107) leaks in.
    expect(page.items.map((i) => i.storyId)).not.toContain("106");
    expect(page.items.map((i) => i.storyId)).not.toContain("107");
  });

  it("includes dirty rows with their last-known denormalized values", async () => {
    const page = await queryStoryListPage(authPool, {
      customerId: CUSTOMER_ID,
    });
    const dirty = page.items.find((i) => i.storyId === "105");
    expect(dirty?.status).toBe("dirty");
    expect(dirty?.priorityTier).toBe("LOW");
  });

  it("filters by priority tier", async () => {
    const page = await queryStoryListPage(authPool, {
      customerId: CUSTOMER_ID,
      priorityTier: "HIGH",
    });
    expect(page.items.map((i) => i.storyId)).toEqual(["103", "104"]);
  });

  it("filters by time window (recency lower bound)", async () => {
    const page = await queryStoryListPage(authPool, {
      customerId: CUSTOMER_ID,
      since: new Date("2026-05-27T00:00:00Z"),
    });
    // recency >= 05-27: 100 (27), 102 (28), 103 (29).
    expect(page.items.map((i) => i.storyId)).toEqual(["100", "102", "103"]);
  });

  it("keyset-paginates every row exactly once, in order, no gaps", async () => {
    const collected: string[] = [];
    let cursor: string | null = null;
    for (let guard = 0; guard < 10; guard++) {
      const page = await queryStoryListPage(authPool, {
        customerId: CUSTOMER_ID,
        cursor,
        pageSize: 3,
      });
      collected.push(...page.items.map((i) => i.storyId));
      cursor = page.nextCursor;
      if (!cursor) break;
    }
    expect(collected).toEqual(FULL_ORDER);
  });

  it("returns an empty page for a customer with no rows", async () => {
    const page = await queryStoryListPage(authPool, {
      customerId: "00000000-0000-0000-0000-0000000000ff",
    });
    expect(page.items).toEqual([]);
    expect(page.nextCursor).toBeNull();
  });
});
