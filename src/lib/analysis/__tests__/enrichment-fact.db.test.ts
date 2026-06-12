// RFC 0003 C1 (#440) — end-to-end enrichment-fact flow (cross-DB):
// generation -> redaction-at-write -> F{k} prompt-build -> input_fact_refs
// -> render demap.
//
// A customer-asset IP (in the customer's registered range) and an external
// IP are both on the feed, so enrichment produces two facts. At the
// DB-write boundary the customer-asset fact is tokenized (raw value only in
// the encrypted `enrichment_redaction_map`) while the external fact stays
// raw. The story worker renames the customer-asset fact's self-scoped token
// to fact-scope `F{k}`, passes the redacted facts to `analyzeStory`, and
// writes `input_fact_refs`. Finally the two-hop render demap resolves `F{k}`
// back to the original customer-asset plaintext.

import { join } from "node:path";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/audit", () => ({ auditLog: vi.fn(async () => {}) }));

// Bypass OpenBao Transit — round-trip the redaction map as plaintext JSON
// so the fact-map write/read can be exercised without a Transit instance
// (mirrors map-write.db.test.ts).
vi.mock("@/lib/redaction/envelope-adapter", () => ({
  encryptRedactionMap: async (_customerId: string, map: unknown) => ({
    ciphertext: Buffer.from(JSON.stringify(map), "utf8"),
    wrappedDek: "test-wrap",
  }),
  decryptRedactionMap: async (_customerId: string, ciphertext: Buffer) =>
    JSON.parse(ciphertext.toString("utf8")),
}));

import {
  closeAdminPool,
  createTestDatabase,
  dropTestDatabase,
  hasPostgres,
} from "@/lib/db/__tests__/db-test-helpers";
import { runMigrations } from "@/lib/db/migrate";
import { decryptRedactionMap } from "@/lib/redaction/envelope-adapter";
import type { RedactionMap } from "@/lib/redaction/types";
import { importFeedSnapshot } from "../enrichment/feed-import";
import { PgFeedStore } from "../enrichment/feed-store";
import { buildLocalFeedDispatcher } from "../enrichment/local-feed-enricher";
import type { SourcePolicy } from "../enrichment/source-policy";
import { runStoryEnrichment } from "../enrichment-worker";
import { restoreStoryFactTokens } from "../fact-token";
import {
  type AnalyzeStoryAimerResponse,
  processStoryJob,
} from "../story-worker";

const AUTH_MIGRATIONS_DIR = join(process.cwd(), "migrations", "auth");
const FEED_MIGRATIONS_DIR = join(process.cwd(), "migrations", "feed");
const CUSTOMER_MIGRATIONS_DIR = join(process.cwd(), "migrations", "customer");
const AUTH_LOCK_ID = 2711;
const FEED_LOCK_ID = 2713;
const CUSTOMER_LOCK_ID = 2712;
const CUSTOMER_ID = "00000000-0000-0000-0000-0000000004c1";
const AICE_ID = "aice-fact-1";
const NOW = "2026-06-04T12:00:00.000Z";
const FRESH = "2026-06-04T06:00:00.000Z";

// The customer's registered range — IPs inside it are customer assets and
// must be tokenized at fact-write.
const CUSTOMER_ASSET_IP = "203.0.113.5";
const CUSTOMER_RANGE = "203.0.113.0/24";
const EXTERNAL_IP = "45.66.230.5";

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
  severityScore: 0.7,
  likelihoodScore: 0.4,
  severityFactors: ["factor"],
  likelihoodFactors: ["factor"],
  ttpTags: [],
  analysis: "placeholder",
  promptVersion: "p1",
  modelActualVersion: "m1",
};

describe.skipIf(!hasPostgres)("enrichment-fact flow (#440, cross-DB)", () => {
  let authDbName: string;
  let authPool: Pool;
  let feedDbName: string;
  let feedPool: Pool;
  let customerDbName: string;
  let customerPool: Pool;
  let capturedFacts: string[] = [];

  const loadRanges = async () =>
    (await import("@/lib/redaction/ranges")).buildRangeSet([CUSTOMER_RANGE]);
  const loadOwnedDomains = async () => ({ normalisedSuffixes: [] });

  const enrichmentOpts = () => ({
    authPool,
    feedPool,
    resolveCustomerPool: () => customerPool,
    now: () => new Date(NOW),
    buildDispatcher: (fp: Pool, now: () => Date) =>
      buildLocalFeedDispatcher(new PgFeedStore(fp), {
        now,
        policies: FLOORING,
      }),
    loadRanges: loadRanges as never,
    loadOwnedDomains: loadOwnedDomains as never,
  });

  const processOpts = () => ({
    authPool,
    resolveCustomerPool: () => customerPool,
    loadRanges: loadRanges as never,
    loadOwnedDomains: loadOwnedDomains as never,
    // Echo the redacted, F-scoped facts back into the analysis text so the
    // render demap has an `F{k}` token to resolve.
    callAnalyzeStory: async (args: { enrichmentFacts: string[] }) => {
      capturedFacts = args.enrichmentFacts;
      return {
        ...AIMER_RESPONSE,
        analysis: `Findings: ${args.enrichmentFacts.join(" || ")}`,
      };
    },
  });

  beforeAll(async () => {
    const auth = await createTestDatabase("fact_e2e_auth");
    authDbName = auth.dbName;
    authPool = auth.pool;
    await runMigrations(authPool, AUTH_MIGRATIONS_DIR, AUTH_LOCK_ID);

    const feed = await createTestDatabase("fact_e2e_feed", "feed");
    feedDbName = feed.dbName;
    feedPool = feed.pool;
    await runMigrations(feedPool, FEED_MIGRATIONS_DIR, FEED_LOCK_ID);

    const cust = await createTestDatabase("fact_e2e_cust");
    customerDbName = cust.dbName;
    customerPool = cust.pool;
    await runMigrations(
      customerPool,
      CUSTOMER_MIGRATIONS_DIR,
      CUSTOMER_LOCK_ID,
    );

    await authPool.query(
      `INSERT INTO customers (id, external_key, name, database_status, timezone)
       VALUES ($1, 'fact-e2e', 'Fact E2E', 'active', 'Asia/Seoul')`,
      [CUSTOMER_ID],
    );
    await importFeedSnapshot(feedPool, {
      sourcePolicyId: "abuse.ch/feodo",
      entityType: "IP",
      hitType: "deterministic_ioc",
      classification: "c2",
      sourceVersion: "2026-06-04",
      sourceUpdatedAt: FRESH,
      rows: [{ matchValue: CUSTOMER_ASSET_IP }, { matchValue: EXTERNAL_IP }],
    });

    // A story whose member event carries both a customer-asset IP and an
    // external IP (both on the feed).
    await customerPool.query(
      `INSERT INTO story
         (story_id, story_version, kind, time_window_start, time_window_end,
          summary_payload, source_aice_id, received_at)
       VALUES (5001::bigint, 'v1', 'auto_correlated',
               '2026-05-01T00:00:00Z', '2026-05-01T01:00:00Z',
               '{}'::jsonb, $1, '2026-05-01T02:00:00Z')`,
      [AICE_ID],
    );
    await customerPool.query(
      `INSERT INTO story_member
         (story_id, story_version, member_event_key, role, event,
          redaction_policy_version)
       VALUES (5001::bigint, 'v1', 1::numeric, 'primary', $1::jsonb,
               'engine:1.0.0|ranges:empty')`,
      [
        JSON.stringify({
          resp_addr: CUSTOMER_ASSET_IP,
          orig_addr: EXTERNAL_IP,
        }),
      ],
    );
    await customerPool.query(
      `INSERT INTO baseline_event
         (baseline_version, event_key, event_time, kind, raw_score, raw_event,
          score_window_context, window_signals, scoring_weights_snapshot,
          source_aice_id)
       VALUES ('b1', 1::numeric, '2026-05-01T00:30:00Z', 'k', 0.5,
               '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, $1)`,
      [AICE_ID],
    );
    await authPool.query(
      `INSERT INTO story_analysis_state (customer_id, story_id, status)
       VALUES ($1, 5001::bigint, 'ready')`,
      [CUSTOMER_ID],
    );
    await authPool.query(
      `INSERT INTO story_analysis_job
         (customer_id, story_id, lang, model_name, model, status, generation)
       VALUES ($1, 5001::bigint, 'ENGLISH', 'openai', 'gpt-4o', 'queued', 1)`,
      [CUSTOMER_ID],
    );
  }, 60_000);

  afterAll(async () => {
    await dropTestDatabase(authDbName, authPool);
    await dropTestDatabase(feedDbName, feedPool, "feed");
    await dropTestDatabase(customerDbName, customerPool);
    await closeAdminPool();
  }, 30_000);

  function job() {
    return {
      customer_id: CUSTOMER_ID,
      story_id: "5001",
      lang: "ENGLISH",
      model_name: "openai",
      model: "gpt-4o",
      generation: 1,
      attempts: 0,
      force_requested_at: null,
      force_requested_by: null,
    };
  }

  it("redacts customer-asset facts at write; external facts stay raw", async () => {
    const outcome = await runStoryEnrichment(
      CUSTOMER_ID,
      "5001",
      enrichmentOpts(),
    );
    expect(outcome.factCount).toBe(2);

    const { rows: facts } = await customerPool.query<{
      fact_id: string;
      fact_text: string;
    }>(
      `SELECT fact_id::text AS fact_id, fact_text
         FROM story_enrichment_fact
        WHERE story_id = 5001::bigint AND story_version = 'v1'
        ORDER BY fact_id`,
    );
    expect(facts).toHaveLength(2);

    const tokenized = facts.find((f) => f.fact_text.includes("<<REDACTED_IP_"));
    const external = facts.find((f) => f.fact_text.includes(EXTERNAL_IP));
    expect(tokenized).toBeDefined();
    expect(external).toBeDefined();
    // The customer-asset plaintext never appears in the stored fact body.
    expect(tokenized?.fact_text).not.toContain(CUSTOMER_ASSET_IP);

    // Exactly one encrypted map row (for the tokenized fact); the external
    // fact has no customer-asset token, so no map row.
    const { rows: maps } = await customerPool.query<{
      fact_id: string;
      ciphertext: Buffer;
      wrapped_dek: string;
    }>(
      `SELECT fact_id::text AS fact_id, ciphertext, wrapped_dek
         FROM enrichment_redaction_map`,
    );
    expect(maps).toHaveLength(1);
    expect(maps[0].fact_id).toBe(tokenized?.fact_id);
    const map = await decryptRedactionMap(
      CUSTOMER_ID,
      maps[0].ciphertext,
      maps[0].wrapped_dek,
    );
    // The raw customer-asset value lives ONLY in the encrypted map.
    expect(Object.values(map).map((e) => e.value)).toContain(CUSTOMER_ASSET_IP);
  });

  it("injects F-scoped facts, writes input_fact_refs, and demaps F{k} at render", async () => {
    await processStoryJob(job(), processOpts());

    // The facts passed to aimer were F-scoped (customer-asset → F{k},
    // external stays raw).
    expect(capturedFacts.some((f) => /<<REDACTED_IP_F\d+_\d+>>/.test(f))).toBe(
      true,
    );
    expect(capturedFacts.some((f) => f.includes(EXTERNAL_IP))).toBe(true);

    const { rows } = await customerPool.query<{
      analysis_text: string;
      input_fact_refs: Array<{ index: number; factId: string }>;
    }>(
      `SELECT analysis_text, input_fact_refs
         FROM story_analysis_result
        WHERE story_id = 5001::bigint`,
    );
    expect(rows).toHaveLength(1);
    const { analysis_text, input_fact_refs } = rows[0];
    expect(input_fact_refs).toHaveLength(2);
    expect(analysis_text).toMatch(/<<REDACTED_IP_F\d+_\d+>>/);
    // The stored analysis carries no customer-asset plaintext.
    expect(analysis_text).not.toContain(CUSTOMER_ASSET_IP);

    // Two-hop render demap: input_fact_refs -> enrichment_redaction_map ->
    // decrypt -> restore (mirrors story-result-page-loader).
    const factMapRows = await customerPool.query<{
      fact_id: string;
      ciphertext: Buffer;
      wrapped_dek: string;
    }>(
      `SELECT fact_id::text AS fact_id, ciphertext, wrapped_dek
         FROM enrichment_redaction_map
        WHERE fact_id IN (${input_fact_refs
          .map((_, i) => `$${i + 1}::bigint`)
          .join(", ")})`,
      input_fact_refs.map((r) => r.factId),
    );
    const byFactId = new Map(
      factMapRows.rows.map((r) => [
        r.fact_id,
        { ciphertext: r.ciphertext, wrapped_dek: r.wrapped_dek },
      ]),
    );
    const mapsByIndex = new Map<number, RedactionMap>();
    for (const ref of input_fact_refs) {
      const found = byFactId.get(ref.factId);
      if (!found) continue;
      mapsByIndex.set(
        ref.index,
        await decryptRedactionMap(
          CUSTOMER_ID,
          found.ciphertext,
          found.wrapped_dek,
        ),
      );
    }
    const restored = restoreStoryFactTokens(analysis_text, mapsByIndex);
    // The viewer-facing render resolves F{k} back to the customer-asset IP.
    expect(restored).toContain(CUSTOMER_ASSET_IP);
    expect(restored).not.toMatch(/<<REDACTED_IP_F\d+_\d+>>/);
  });
});
