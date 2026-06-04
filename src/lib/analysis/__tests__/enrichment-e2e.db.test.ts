// RFC 0003 P1a (#361) — end-to-end staging verification (cross-DB).
//
// Mirrors the issue's E2E: fixture-pinned severityScore=0.85,
// likelihoodScore=0.3; two distinct story_ids identical except for the
// derived `known_ioc_hit`. Enrichment derives the floor input, then the
// story-analysis worker reads it:
//   - known_ioc_hit=false → likelihood 0.3 stays raw → MEDIUM
//   - known_ioc_hit=true  → likelihood floored to 0.95 → CRITICAL
// and the on-disk `likelihood_score` stays raw (0.3) in both cases (the
// floor affects only the derived `priority_tier`, per #292).
//
// Also asserts the ordering guarantee: a story whose enrichment has not
// completed requeues its analysis job (no LLM call, no result) rather
// than reading a stale floor.

import { join } from "node:path";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/audit", () => ({ auditLog: vi.fn(async () => {}) }));

import {
  closeAdminPool,
  createTestDatabase,
  dropTestDatabase,
  hasPostgres,
} from "@/lib/db/__tests__/db-test-helpers";
import { runMigrations } from "@/lib/db/migrate";
import { buildRangeSet } from "@/lib/redaction/ranges";
import { importFeedSnapshot } from "../enrichment/feed-import";
import { PgFeedStore } from "../enrichment/feed-store";
import { buildLocalFeedDispatcher } from "../enrichment/local-feed-enricher";
import type { SourcePolicy } from "../enrichment/source-policy";
import { runStoryEnrichment } from "../enrichment-worker";
import {
  type AnalyzeStoryAimerResponse,
  processStoryJob,
} from "../story-worker";

const AUTH_MIGRATIONS_DIR = join(process.cwd(), "migrations", "auth");
const CUSTOMER_MIGRATIONS_DIR = join(process.cwd(), "migrations", "customer");
const AUTH_LOCK_ID = 2611;
const CUSTOMER_LOCK_ID = 2612;
const CUSTOMER_ID = "00000000-0000-0000-0000-0000000003b1";
const AICE_ID = "aice-1";
const NOW = "2026-06-04T12:00:00.000Z";
const FRESH = "2026-06-04T06:00:00.000Z";

const FLOORING: SourcePolicy[] = [
  {
    sourcePolicyId: "abuse.ch/feodo",
    label: "abuse.ch Feodo Tracker",
    entityTypes: ["IP"],
    deterministicCoverage: true,
    maxAge: 2 * 24 * 60 * 60 * 1000,
    floorEligible: true,
  },
];

const AIMER_RESPONSE: AnalyzeStoryAimerResponse = {
  severityScore: 0.85,
  likelihoodScore: 0.3,
  severityFactors: ["factor"],
  likelihoodFactors: ["factor"],
  ttpTags: [],
  analysis: "Investigation summary.",
  promptVersion: "p1",
  modelActualVersion: "m1",
};

describe.skipIf(!hasPostgres)("IOC floor end-to-end (cross-DB)", () => {
  let authDbName: string;
  let authPool: Pool;
  let customerDbName: string;
  let customerPool: Pool;
  let llmCalls: number;

  const enrichmentOpts = () => ({
    authPool,
    resolveCustomerPool: () => customerPool,
    now: () => new Date(NOW),
    buildDispatcher: (ap: Pool, now: () => Date) =>
      buildLocalFeedDispatcher(new PgFeedStore(ap), {
        now,
        policies: FLOORING,
      }),
  });

  const processOpts = () => ({
    authPool,
    resolveCustomerPool: () => customerPool,
    loadRanges: async () => buildRangeSet([]),
    callAnalyzeStory: async () => {
      llmCalls += 1;
      return AIMER_RESPONSE;
    },
  });

  beforeAll(async () => {
    const auth = await createTestDatabase("ioc_e2e_auth");
    authDbName = auth.dbName;
    authPool = auth.pool;
    await runMigrations(authPool, AUTH_MIGRATIONS_DIR, AUTH_LOCK_ID);

    const cust = await createTestDatabase("ioc_e2e_cust");
    customerDbName = cust.dbName;
    customerPool = cust.pool;
    await runMigrations(
      customerPool,
      CUSTOMER_MIGRATIONS_DIR,
      CUSTOMER_LOCK_ID,
    );

    await authPool.query(
      `INSERT INTO customers (id, external_key, name, database_status, timezone)
       VALUES ($1, 'ioc-e2e', 'IOC E2E', 'active', 'Asia/Seoul')`,
      [CUSTOMER_ID],
    );
    await importFeedSnapshot(authPool, {
      sourcePolicyId: "abuse.ch/feodo",
      entityType: "IP",
      hitType: "deterministic_ioc",
      sourceVersion: "2026-06-04",
      sourceUpdatedAt: FRESH,
      rows: [{ matchValue: "45.66.230.5" }],
    });
  }, 60_000);

  afterAll(async () => {
    await dropTestDatabase(authDbName, authPool);
    await dropTestDatabase(customerDbName, customerPool);
    await closeAdminPool();
  }, 30_000);

  async function seedAnalyzableStory(
    storyId: string,
    respAddr: string,
  ): Promise<void> {
    await customerPool.query(
      `INSERT INTO story
         (story_id, story_version, kind, time_window_start, time_window_end,
          summary_payload, source_aice_id, received_at)
       VALUES ($1::bigint, 'v1', 'auto_correlated',
               '2026-05-01T00:00:00Z', '2026-05-01T01:00:00Z',
               '{}'::jsonb, $2, '2026-05-01T02:00:00Z')`,
      [storyId, AICE_ID],
    );
    await customerPool.query(
      `INSERT INTO story_member
         (story_id, story_version, member_event_key, role, event,
          redaction_policy_version)
       VALUES ($1::bigint, 'v1', 1::numeric, 'primary', $2::jsonb,
               'engine:1.0.0|ranges:empty')`,
      [storyId, JSON.stringify({ resp_addr: respAddr })],
    );
    // baseline_event supplies the member's event_time (RFC 0002 #344).
    await customerPool.query(
      `INSERT INTO baseline_event
         (baseline_version, event_key, event_time, kind, raw_score, raw_event,
          score_window_context, window_signals, scoring_weights_snapshot,
          source_aice_id)
       VALUES ('b1', 1::numeric, '2026-05-01T00:30:00Z', 'k', 0.5,
               '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, $1)
       ON CONFLICT (baseline_version, event_key) DO NOTHING`,
      [AICE_ID],
    );
    await authPool.query(
      `INSERT INTO story_analysis_state (customer_id, story_id, status)
       VALUES ($1, $2::bigint, 'ready')`,
      [CUSTOMER_ID, storyId],
    );
    await authPool.query(
      `INSERT INTO story_analysis_job
         (customer_id, story_id, lang, model_name, model, status, generation)
       VALUES ($1, $2::bigint, 'ENGLISH', 'openai', 'gpt-4o', 'queued', 1)`,
      [CUSTOMER_ID, storyId],
    );
  }

  function job(storyId: string) {
    return {
      customer_id: CUSTOMER_ID,
      story_id: storyId,
      lang: "ENGLISH",
      model_name: "openai",
      model: "gpt-4o",
      generation: 1,
      attempts: 0,
      force_requested_at: null,
      force_requested_by: null,
    };
  }

  async function priorityOf(storyId: string): Promise<string> {
    const { rows } = await customerPool.query<{ priority_tier: string }>(
      `SELECT priority_tier FROM story_analysis_result
        WHERE story_id = $1::bigint`,
      [storyId],
    );
    return rows[0]?.priority_tier;
  }

  async function likelihoodOf(storyId: string): Promise<number> {
    const { rows } = await customerPool.query<{ likelihood_score: number }>(
      `SELECT likelihood_score FROM story_analysis_result
        WHERE story_id = $1::bigint`,
      [storyId],
    );
    return rows[0]?.likelihood_score;
  }

  it("known_ioc_hit=false → MEDIUM; known_ioc_hit=true → CRITICAL; likelihood stays raw", async () => {
    llmCalls = 0;
    // Story 2001: external IP not on any feed → no hit.
    await seedAnalyzableStory("2001", "45.66.230.99");
    // Story 2002: external IP on the Feodo feed → floor-eligible hit.
    await seedAnalyzableStory("2002", "45.66.230.5");

    // Async enrichment runs first (as the poll loop does), deriving the
    // floor input and the completion marker for each canonical version.
    const enrichA = await runStoryEnrichment(
      CUSTOMER_ID,
      "2001",
      enrichmentOpts(),
    );
    expect(enrichA.knownIocHit).toBe(false);
    const enrichB = await runStoryEnrichment(
      CUSTOMER_ID,
      "2002",
      enrichmentOpts(),
    );
    expect(enrichB.knownIocHit).toBe(true);

    await processStoryJob(job("2001"), processOpts());
    await processStoryJob(job("2002"), processOpts());

    expect(llmCalls).toBe(2);
    expect(await priorityOf("2001")).toBe("MEDIUM");
    expect(await priorityOf("2002")).toBe("CRITICAL");
    // The floor never touches the stored score — both rows hold raw 0.3.
    expect(await likelihoodOf("2001")).toBe(0.3);
    expect(await likelihoodOf("2002")).toBe(0.3);
  });

  it("requeues analysis (no LLM, no result) until enrichment completes", async () => {
    llmCalls = 0;
    await seedAnalyzableStory("2003", "45.66.230.5");
    // No runStoryEnrichment → no completion marker for the canonical version.

    await processStoryJob(job("2003"), processOpts());

    expect(llmCalls).toBe(0);
    expect(await priorityOf("2003")).toBeUndefined();
    const { rows } = await authPool.query<{ status: string; attempts: number }>(
      `SELECT status, attempts FROM story_analysis_job
        WHERE customer_id = $1 AND story_id = 2003`,
      [CUSTOMER_ID],
    );
    // Re-queued for the next tick, WITHOUT consuming a retry attempt.
    expect(rows[0].status).toBe("queued");
    expect(rows[0].attempts).toBe(0);

    // Once enrichment completes, the same job proceeds and floors to CRITICAL.
    await runStoryEnrichment(CUSTOMER_ID, "2003", enrichmentOpts());
    await processStoryJob(job("2003"), processOpts());
    expect(llmCalls).toBe(1);
    expect(await priorityOf("2003")).toBe("CRITICAL");
  });
});
