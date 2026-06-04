// RFC 0003 P1a (#361) — enrichment worker integration (cross-DB).
//
// Drives `runStoryEnrichment` against a real customer DB (story / member /
// evidence / state) and a real auth DB (ioc_feed_snapshot), covering:
//   - known_ioc_hit true (floor-eligible deterministic hit) + evidence +
//     HMAC reproducibility across a key rotation,
//   - false-complete (answered, no hit) vs false-unknown (missing feed),
//   - redaction-map recovery of a tokenized customer-asset IP,
//   - the boolean stays monotonic (stale feed never flips a hit).
//
// Feeds use a floor-eligible policy set (simulating a license-cleared
// feed); the SHIPPED policies are floorEligible:false (licensing gate),
// exercised separately in the unit tests. Indicators use genuine
// public-unicast IPs (RFC 5737 doc ranges classify as `reserved` →
// non-public → never floor-eligible).

import { join } from "node:path";
import type { Pool } from "pg";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

vi.mock("server-only", () => ({}));

import {
  closeAdminPool,
  createTestDatabase,
  dropTestDatabase,
  hasPostgres,
} from "@/lib/db/__tests__/db-test-helpers";
import { runMigrations } from "@/lib/db/migrate";
import { HmacKeyRing, verifyIndicatorHmac } from "../enrichment/evidence";
import { importFeedSnapshot } from "../enrichment/feed-import";
import { PgFeedStore } from "../enrichment/feed-store";
import { seedFixtureFeeds } from "../enrichment/fixture-feeds";
import { buildLocalFeedDispatcher } from "../enrichment/local-feed-enricher";
import { normalizeIp, normalizeUrl } from "../enrichment/normalization";
import type { SourcePolicy } from "../enrichment/source-policy";
import {
  type EnrichmentWorkerOptions,
  runStoryEnrichment,
  tickStoryEnrichmentOnce,
} from "../enrichment-worker";

const AUTH_MIGRATIONS_DIR = join(process.cwd(), "migrations", "auth");
const CUSTOMER_MIGRATIONS_DIR = join(process.cwd(), "migrations", "customer");
const AUTH_LOCK_ID = 2601;
const CUSTOMER_LOCK_ID = 2602;
const CUSTOMER_ID = "00000000-0000-0000-0000-0000000003a1";
const AICE_ID = "aice-1";

const NOW = "2026-06-04T12:00:00.000Z";
const FRESH = "2026-06-04T06:00:00.000Z"; // within 2-day maxAge
const STALE = "2026-05-01T00:00:00.000Z"; // well past maxAge

// A floor-eligible single-source policy set: only Feodo (IP), so the
// relevant deterministic IP source set has exactly one member and a
// present+fresh snapshot reads as `complete` coverage.
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

const keyRing = new HmacKeyRing({ v1: "test-key-v1" }, "v1");

function opts(
  authPool: Pool,
  customerPool: Pool,
  overrides: Partial<EnrichmentWorkerOptions> = {},
): EnrichmentWorkerOptions {
  return {
    authPool,
    resolveCustomerPool: () => customerPool,
    now: () => new Date(NOW),
    keyRing,
    buildDispatcher: (ap, now) =>
      buildLocalFeedDispatcher(new PgFeedStore(ap), {
        now,
        policies: FLOORING,
      }),
    ...overrides,
  };
}

async function seedStory(
  customerPool: Pool,
  storyId: string,
  event: unknown,
  storyVersion = "v1",
): Promise<void> {
  await customerPool.query(
    `INSERT INTO story
       (story_id, story_version, kind, time_window_start, time_window_end,
        summary_payload, source_aice_id, received_at)
     VALUES ($1::bigint, $2, 'auto_correlated',
             '2026-05-01T00:00:00Z', '2026-05-01T01:00:00Z',
             '{}'::jsonb, $3, '2026-05-01T02:00:00Z')`,
    [storyId, storyVersion, AICE_ID],
  );
  await customerPool.query(
    `INSERT INTO story_member
       (story_id, story_version, member_event_key, role, event,
        redaction_policy_version)
     VALUES ($1::bigint, $2, 1::numeric, 'primary', $3::jsonb,
             'engine:1.0.0|ranges:empty')`,
    [storyId, storyVersion, JSON.stringify(event)],
  );
}

/**
 * Seed a `policy_event` row for `eventKey` carrying the IOC only in the
 * discrete typed columns (separate storage from `story_member.event`).
 * `seedStory` uses member_event_key = 1, so the default event_key matches.
 */
async function seedPolicyEvent(
  customerPool: Pool,
  runId: string,
  fields: Partial<PolicyEventFields>,
  eventKey = "1",
): Promise<void> {
  await customerPool.query(
    `INSERT INTO policy_run
       (run_id, period_start, period_end, created_at_source,
        baseline_version, policies_fingerprint, exclusions_fingerprint,
        status, source_aice_id)
     VALUES ($1::bigint, '2026-05-01T00:00:00Z', '2026-05-01T01:00:00Z',
             '2026-05-01T00:00:00Z', 'bv1', 'pf', 'ef', 'ready', $2)
     ON CONFLICT (run_id) DO NOTHING`,
    [runId, AICE_ID],
  );
  await customerPool.query(
    `INSERT INTO policy_event
       (run_id, event_key, event_time, kind, orig_addr, resp_addr,
        host, dns_query, uri, policy_triage_snapshot,
        redaction_policy_version)
     VALUES ($1::bigint, $2::numeric, '2026-05-01T00:00:00Z', 'conn',
             $3, $4, $5, $6, $7, '{}'::jsonb, 'engine:1.0.0|ranges:empty')`,
    [
      runId,
      eventKey,
      fields.orig_addr ?? null,
      fields.resp_addr ?? null,
      fields.host ?? null,
      fields.dns_query ?? null,
      fields.uri ?? null,
    ],
  );
}

interface PolicyEventFields {
  orig_addr: string | null;
  resp_addr: string | null;
  host: string | null;
  dns_query: string | null;
  uri: string | null;
}

async function importFeodo(authPool: Pool, sourceUpdatedAt: string) {
  await importFeedSnapshot(authPool, {
    sourcePolicyId: "abuse.ch/feodo",
    entityType: "IP",
    hitType: "deterministic_ioc",
    classification: "c2",
    sourceVersion: "2026-06-04",
    sourceUpdatedAt,
    rows: [{ matchValue: "45.66.230.5" }],
  });
}

describe.skipIf(!hasPostgres)("IOC enrichment worker (cross-DB)", () => {
  let authDbName: string;
  let authPool: Pool;
  let customerDbName: string;
  let customerPool: Pool;

  beforeAll(async () => {
    const auth = await createTestDatabase("ioc_enrich_auth");
    authDbName = auth.dbName;
    authPool = auth.pool;
    await runMigrations(authPool, AUTH_MIGRATIONS_DIR, AUTH_LOCK_ID);

    const cust = await createTestDatabase("ioc_enrich_cust");
    customerDbName = cust.dbName;
    customerPool = cust.pool;
    await runMigrations(
      customerPool,
      CUSTOMER_MIGRATIONS_DIR,
      CUSTOMER_LOCK_ID,
    );

    await authPool.query(
      `INSERT INTO customers (id, external_key, name, database_status, timezone)
       VALUES ($1, 'ioc-enrich', 'IOC Enrich', 'active', 'Asia/Seoul')`,
      [CUSTOMER_ID],
    );
  }, 60_000);

  afterAll(async () => {
    await dropTestDatabase(authDbName, authPool);
    await dropTestDatabase(customerDbName, customerPool);
    await closeAdminPool();
  }, 30_000);

  beforeEach(async () => {
    await customerPool.query("DELETE FROM story");
    await customerPool.query("DELETE FROM policy_run");
    await authPool.query("DELETE FROM ioc_feed_snapshot");
    await authPool.query("DELETE FROM story_analysis_state");
  });

  it("derives known_ioc_hit=true, flips the floor, and persists evidence", async () => {
    await importFeodo(authPool, FRESH);
    await seedStory(customerPool, "1001", { resp_addr: "45.66.230.5" });

    const result = await runStoryEnrichment(
      CUSTOMER_ID,
      "1001",
      opts(authPool, customerPool),
    );
    expect(result.knownIocHit).toBe(true);
    expect(result.coverageStatus).toBe("complete");
    expect(result.evidenceCount).toBe(1);

    // story.known_ioc_hit flipped from the inert default.
    const { rows: storyRows } = await customerPool.query<{
      known_ioc_hit: boolean;
    }>(
      `SELECT known_ioc_hit FROM story
        WHERE story_id = 1001 AND story_version = 'v1'`,
    );
    expect(storyRows[0].known_ioc_hit).toBe(true);

    // Completion marker.
    const { rows: stateRows } = await customerPool.query<{
      status: string;
      coverage_status: string;
      known_ioc_hit: boolean;
    }>(
      `SELECT status, coverage_status, known_ioc_hit
         FROM story_enrichment_state
        WHERE story_id = 1001 AND story_version = 'v1'`,
    );
    expect(stateRows[0].status).toBe("complete");
    expect(stateRows[0].coverage_status).toBe("complete");
    expect(stateRows[0].known_ioc_hit).toBe(true);

    // Evidence record carries the audit fields; no plaintext indicator.
    const { rows: ev } = await customerPool.query<{
      redaction_token: string;
      normalized_indicator_hmac: string;
      hmac_key_version: string;
      normalization_version: string;
      source_policy_id: string;
      source_version: string;
      feed_hash: string;
      hit_type: string;
      floor_eligible: boolean;
    }>(
      `SELECT * FROM story_ioc_evidence
        WHERE story_id = 1001 AND story_version = 'v1'`,
    );
    expect(ev).toHaveLength(1);
    const e = ev[0];
    // External raw indicator → identity token is the raw value.
    expect(e.redaction_token).toBe("45.66.230.5");
    expect(e.source_policy_id).toBe("abuse.ch/feodo");
    expect(e.source_version).toBe("2026-06-04");
    expect(e.feed_hash).toBeTruthy();
    expect(e.hit_type).toBe("deterministic_ioc");
    expect(e.floor_eligible).toBe(true);
    expect(e.normalization_version).toBe("ti-norm-1");
    // No plaintext indicator column exists; the HMAC verifies the value.
    expect(
      verifyIndicatorHmac(
        normalizeIp("45.66.230.5"),
        {
          normalizedIndicatorHmac: e.normalized_indicator_hmac,
          hmacKeyVersion: e.hmac_key_version,
        },
        keyRing,
      ),
    ).toBe(true);

    // HMAC still verifies across a key rotation (old version retained).
    const rotated = new HmacKeyRing(
      { v1: "test-key-v1", v2: "test-key-v2" },
      "v2",
    );
    expect(
      verifyIndicatorHmac(
        normalizeIp("45.66.230.5"),
        {
          normalizedIndicatorHmac: e.normalized_indicator_hmac,
          hmacKeyVersion: e.hmac_key_version,
        },
        rotated,
      ),
    ).toBe(true);
  });

  it("false-complete: answered, no hit → no evidence, coverage complete", async () => {
    await importFeodo(authPool, FRESH);
    await seedStory(customerPool, "1002", { resp_addr: "45.66.230.99" });

    const result = await runStoryEnrichment(
      CUSTOMER_ID,
      "1002",
      opts(authPool, customerPool),
    );
    expect(result.knownIocHit).toBe(false);
    expect(result.coverageStatus).toBe("complete");
    expect(result.evidenceCount).toBe(0);

    const { rows } = await customerPool.query<{ known_ioc_hit: boolean }>(
      `SELECT known_ioc_hit FROM story
        WHERE story_id = 1002 AND story_version = 'v1'`,
    );
    expect(rows[0].known_ioc_hit).toBe(false);
  });

  it("false-unknown: missing feed snapshot → coverage unknown, not silent false", async () => {
    // No importFeodo: the snapshot is absent → unavailable → unknown.
    await seedStory(customerPool, "1003", { resp_addr: "45.66.230.5" });

    const result = await runStoryEnrichment(
      CUSTOMER_ID,
      "1003",
      opts(authPool, customerPool),
    );
    expect(result.knownIocHit).toBe(false);
    expect(result.coverageStatus).toBe("unknown");

    const { rows } = await customerPool.query<{
      status: string;
      coverage_status: string;
    }>(
      `SELECT status, coverage_status FROM story_enrichment_state
        WHERE story_id = 1003 AND story_version = 'v1'`,
    );
    // The run completed (distinguishable from "never ran"), but coverage
    // records the gap rather than asserting a clean false.
    expect(rows[0].status).toBe("complete");
    expect(rows[0].coverage_status).toBe("unknown");
  });

  it("recovers a tokenized customer-asset IP via the redaction map", async () => {
    await importFeodo(authPool, FRESH);
    // The stored member text carries a token; the recovered value is a
    // public IP inside the (here simulated) customer-registered range, so
    // it is floor-eligible and listed in the feed.
    await seedStory(customerPool, "1004", { orig_addr: "<<REDACTED_IP_001>>" });

    const result = await runStoryEnrichment(
      CUSTOMER_ID,
      "1004",
      opts(authPool, customerPool, {
        loadRedactionMap: async () => ({
          "<<REDACTED_IP_001>>": { kind: "ip", value: "45.66.230.5" },
        }),
      }),
    );
    expect(result.knownIocHit).toBe(true);
    expect(result.evidenceCount).toBe(1);

    const { rows: ev } = await customerPool.query<{ redaction_token: string }>(
      `SELECT redaction_token FROM story_ioc_evidence
        WHERE story_id = 1004 AND story_version = 'v1'`,
    );
    // Recovered value → the TOKEN is the evidence reference, not the value.
    expect(ev[0].redaction_token).toBe("<<REDACTED_IP_001>>");
  });

  it("extracts an IOC present only in the policy_event typed columns", async () => {
    await importFeodo(authPool, FRESH);
    // The member JSONB carries NO indicator; the IOC lives only in the
    // discrete policy_event.resp_addr column for the same event_key. A
    // worker that read story_member.event alone would mark the story
    // complete with known_ioc_hit=false and never flip the floor.
    await seedStory(customerPool, "1007", { note: "no indicator in JSONB" });
    await seedPolicyEvent(customerPool, "5001", { resp_addr: "45.66.230.5" });

    const result = await runStoryEnrichment(
      CUSTOMER_ID,
      "1007",
      opts(authPool, customerPool),
    );
    expect(result.knownIocHit).toBe(true);
    expect(result.evidenceCount).toBe(1);

    const { rows } = await customerPool.query<{ known_ioc_hit: boolean }>(
      `SELECT known_ioc_hit FROM story
        WHERE story_id = 1007 AND story_version = 'v1'`,
    );
    expect(rows[0].known_ioc_hit).toBe(true);
  });

  it("recovers a tokenized IP from a policy_event column via the map", async () => {
    await importFeodo(authPool, FRESH);
    // The IOC is tokenized in policy_event.orig_addr (a customer-asset IP),
    // absent from the member JSONB. Token recovery uses the same
    // event_redaction_map row as the member text.
    await seedStory(customerPool, "1008", { note: "no indicator in JSONB" });
    await seedPolicyEvent(customerPool, "5002", {
      orig_addr: "<<REDACTED_IP_001>>",
    });

    const result = await runStoryEnrichment(
      CUSTOMER_ID,
      "1008",
      opts(authPool, customerPool, {
        loadRedactionMap: async () => ({
          "<<REDACTED_IP_001>>": { kind: "ip", value: "45.66.230.5" },
        }),
      }),
    );
    expect(result.knownIocHit).toBe(true);

    const { rows: ev } = await customerPool.query<{ redaction_token: string }>(
      `SELECT redaction_token FROM story_ioc_evidence
        WHERE story_id = 1008 AND story_version = 'v1'`,
    );
    expect(ev[0].redaction_token).toBe("<<REDACTED_IP_001>>");
  });

  it("seeds the pinned fixture feeds and matches a fixture IP via PgFeedStore", async () => {
    await seedFixtureFeeds(authPool, { sourceUpdatedAt: FRESH });
    const store = new PgFeedStore(authPool);

    // Feodo fixture snapshot is present + fresh.
    const probe = await store.probe("abuse.ch/feodo");
    expect(probe.present).toBe(true);
    expect(probe.sourceUpdatedAt).toBe(FRESH);

    // A fixture IP matches (doc-range → reserved/non-public, so it would
    // not floor, but the feed match itself is exercised).
    const feodoHit = await store.match(
      "abuse.ch/feodo",
      normalizeIp("203.0.113.10"),
    );
    expect(feodoHit.length).toBeGreaterThan(0);
    expect(feodoHit[0].hitType).toBe("deterministic_ioc");

    // Spamhaus DROP CIDR fixture matches by containment.
    const dropHit = await store.match(
      "spamhaus/drop",
      normalizeIp("192.0.2.50"),
    );
    expect(dropHit.length).toBeGreaterThan(0);

    // URLhaus fixture matches the exact canonical URL.
    const urlHit = await store.match(
      "abuse.ch/urlhaus",
      normalizeUrl("http://malware.example/payload.exe"),
    );
    expect(urlHit.length).toBeGreaterThan(0);
  });

  it("tickStoryEnrichmentOnce enriches stories with a queued analysis job", async () => {
    await importFeodo(authPool, FRESH);
    await seedStory(customerPool, "1006", { resp_addr: "45.66.230.5" });
    // A ready state + queued real job make this story a candidate.
    await authPool.query(
      `INSERT INTO story_analysis_state (customer_id, story_id, status)
       VALUES ($1, 1006::bigint, 'ready')`,
      [CUSTOMER_ID],
    );
    await authPool.query(
      `INSERT INTO story_analysis_job
         (customer_id, story_id, lang, model_name, model, status, generation)
       VALUES ($1, 1006::bigint, 'ENGLISH', 'openai', 'gpt-4o', 'queued', 1)`,
      [CUSTOMER_ID],
    );

    const enriched = await tickStoryEnrichmentOnce(
      authPool,
      10,
      opts(authPool, customerPool),
    );
    expect(enriched).toBe(1);

    const { rows } = await customerPool.query<{
      status: string;
      known_ioc_hit: boolean;
    }>(
      `SELECT status, known_ioc_hit FROM story_enrichment_state
        WHERE story_id = 1006 AND story_version = 'v1'`,
    );
    expect(rows[0].status).toBe("complete");
    expect(rows[0].known_ioc_hit).toBe(true);

    // A second tick skips the already-complete story.
    const again = await tickStoryEnrichmentOnce(
      authPool,
      10,
      opts(authPool, customerPool),
    );
    expect(again).toBe(0);
  });

  it("a stale feed still reports the hit (boolean monotonic) but coverage is stale", async () => {
    await importFeodo(authPool, STALE);
    await seedStory(customerPool, "1005", { resp_addr: "45.66.230.5" });

    const result = await runStoryEnrichment(
      CUSTOMER_ID,
      "1005",
      opts(authPool, customerPool),
    );
    expect(result.knownIocHit).toBe(true);
    expect(result.coverageStatus).toBe("stale");
  });
});
