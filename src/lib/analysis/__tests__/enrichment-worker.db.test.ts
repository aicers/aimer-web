// RFC 0003 P1a (#361) — enrichment worker integration (cross-DB).
//
// Drives `runStoryEnrichment` against a real customer DB (story / member /
// evidence / state) and a dedicated feed DB (ioc_feed_snapshot), covering:
//   - known_ioc_hit true (floor-eligible deterministic hit) + evidence
//     storing the external indicator raw in `redaction_token`,
//   - false-complete (answered, no hit) vs false-unknown (missing feed),
//   - redaction-map recovery of a tokenized customer-asset IP (stored as a
//     token whose raw value lives only in the redaction map),
//   - the boolean stays monotonic (stale feed never flips a hit),
//   - typed policy_event columns are scoped to the story's source_aice_id
//     (a different source's same-event_key IOC must not flip the floor),
//   - a rerun with no current match preserves prior evidence so a retained
//     monotonic `true` stays explainable.
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
import { importFeedSnapshot } from "../enrichment/feed-import";
import { PgFeedStore } from "../enrichment/feed-store";
import { seedFixtureFeeds } from "../enrichment/fixture-feeds";
import { buildLocalFeedDispatcher } from "../enrichment/local-feed-enricher";
import {
  normalizeDomain,
  normalizeHash,
  normalizeIp,
  normalizeUrl,
} from "../enrichment/normalization";
import type { SourcePolicy } from "../enrichment/source-policy";
import {
  type EnrichmentWorkerOptions,
  runStoryEnrichment,
  tickStoryEnrichmentOnce,
} from "../enrichment-worker";

const AUTH_MIGRATIONS_DIR = join(process.cwd(), "migrations", "auth");
const FEED_MIGRATIONS_DIR = join(process.cwd(), "migrations", "feed");
const CUSTOMER_MIGRATIONS_DIR = join(process.cwd(), "migrations", "customer");
const AUTH_LOCK_ID = 2601;
const FEED_LOCK_ID = 2603;
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

function opts(
  authPool: Pool,
  feedPool: Pool,
  customerPool: Pool,
  overrides: Partial<EnrichmentWorkerOptions> = {},
): EnrichmentWorkerOptions {
  return {
    authPool,
    feedPool,
    resolveCustomerPool: () => customerPool,
    now: () => new Date(NOW),
    buildDispatcher: (fp, now) =>
      buildLocalFeedDispatcher(new PgFeedStore(fp), {
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
  sourceAiceId = AICE_ID,
): Promise<void> {
  await customerPool.query(
    `INSERT INTO policy_run
       (run_id, period_start, period_end, created_at_source,
        baseline_version, policies_fingerprint, exclusions_fingerprint,
        status, source_aice_id)
     VALUES ($1::bigint, '2026-05-01T00:00:00Z', '2026-05-01T01:00:00Z',
             '2026-05-01T00:00:00Z', 'bv1', 'pf', 'ef', 'ready', $2)
     ON CONFLICT (run_id) DO NOTHING`,
    [runId, sourceAiceId],
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

async function importFeodo(feedPool: Pool, sourceUpdatedAt: string) {
  await importFeedSnapshot(feedPool, {
    sourcePolicyId: "abuse.ch/feodo",
    entityType: "IP",
    hitType: "deterministic_ioc",
    classification: "c2",
    sourceVersion: "2026-06-04",
    sourceUpdatedAt,
    rows: [{ matchValue: "45.66.230.5" }],
  });
}

// A floor-INELIGIBLE deterministic source — the SHIPPED posture (every
// current feed is floorEligible:false pending OQ9 licensing). Used to prove a
// floor-ineligible deterministic hit is ALWAYS promoted as evidence-only (not
// floor-driving, not gated) per #589 Scope 1.
const NONFLOORING_DET: SourcePolicy[] = [
  {
    sourcePolicyId: "abuse.ch/feodo",
    label: "abuse.ch Feodo Tracker",
    entityTypes: ["IP"],
    deterministicCoverage: true,
    maxAge: 2 * 24 * 60 * 60 * 1000,
    floorEligible: false,
  },
];

// Soft-reputation IP sources (never floor-driving; deterministicCoverage:false
// so they do not affect the deterministic coverage status). Two distinct
// sources so multi-source corroboration can be exercised.
const SOFT_A: SourcePolicy = {
  sourcePolicyId: "soft/rep-a",
  label: "Soft Reputation A",
  entityTypes: ["IP"],
  deterministicCoverage: false,
  maxAge: 2 * 24 * 60 * 60 * 1000,
  floorEligible: false,
};
const SOFT_B: SourcePolicy = {
  sourcePolicyId: "soft/rep-b",
  label: "Soft Reputation B",
  entityTypes: ["IP"],
  deterministicCoverage: false,
  maxAge: 2 * 24 * 60 * 60 * 1000,
  floorEligible: false,
};

async function importSoft(
  feedPool: Pool,
  sourcePolicyId: string,
  confidence: number | undefined,
  matchValue = "45.66.230.5",
  sourceUpdatedAt = FRESH,
) {
  await importFeedSnapshot(feedPool, {
    sourcePolicyId,
    entityType: "IP",
    hitType: "soft_reputation",
    classification: "suspicious",
    confidence,
    sourceVersion: "2026-06-04",
    sourceUpdatedAt,
    rows: [{ matchValue }],
  });
}

function optsWithPolicies(
  authPool: Pool,
  feedPool: Pool,
  customerPool: Pool,
  policies: SourcePolicy[],
  overrides: Partial<EnrichmentWorkerOptions> = {},
): EnrichmentWorkerOptions {
  return opts(authPool, feedPool, customerPool, {
    buildDispatcher: (fp, now) =>
      buildLocalFeedDispatcher(new PgFeedStore(fp), { now, policies }),
    ...overrides,
  });
}

describe.skipIf(!hasPostgres)("IOC enrichment worker (cross-DB)", () => {
  let authDbName: string;
  let authPool: Pool;
  let feedDbName: string;
  let feedPool: Pool;
  let customerDbName: string;
  let customerPool: Pool;

  beforeAll(async () => {
    const auth = await createTestDatabase("ioc_enrich_auth");
    authDbName = auth.dbName;
    authPool = auth.pool;
    await runMigrations(authPool, AUTH_MIGRATIONS_DIR, AUTH_LOCK_ID);

    const feed = await createTestDatabase("ioc_enrich_feed", "feed");
    feedDbName = feed.dbName;
    feedPool = feed.pool;
    await runMigrations(feedPool, FEED_MIGRATIONS_DIR, FEED_LOCK_ID);

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
    await dropTestDatabase(feedDbName, feedPool, "feed");
    await dropTestDatabase(customerDbName, customerPool);
    await closeAdminPool();
  }, 30_000);

  beforeEach(async () => {
    await customerPool.query("DELETE FROM story");
    await customerPool.query("DELETE FROM policy_run");
    await feedPool.query("DELETE FROM ioc_feed_snapshot");
    await authPool.query("DELETE FROM story_analysis_state");
  });

  it("derives known_ioc_hit=true, flips the floor, and persists evidence", async () => {
    await importFeodo(feedPool, FRESH);
    await seedStory(customerPool, "1001", { resp_addr: "45.66.230.5" });

    const result = await runStoryEnrichment(
      CUSTOMER_ID,
      "1001",
      opts(authPool, feedPool, customerPool),
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

    // Evidence record carries the provenance fields and the
    // redaction-consistent indicator reference.
    const { rows: ev } = await customerPool.query<{
      redaction_token: string;
      source_aice_id: string;
      member_event_key: string;
      source_policy_id: string;
      source_version: string;
      feed_hash: string;
      hit_type: string;
      floor_eligible: boolean;
      coverage_status: string;
      checked_at: Date;
    }>(
      `SELECT * FROM story_ioc_evidence
        WHERE story_id = 1001 AND story_version = 'v1'`,
    );
    expect(ev).toHaveLength(1);
    const e = ev[0];
    // External indicator → stored RAW in redaction_token (redaction-consistent).
    expect(e.redaction_token).toBe("45.66.230.5");
    // Provenance: which member event the hit came from. (node-pg returns
    // NUMERIC as a string.)
    expect(e.source_aice_id).toBe(AICE_ID);
    expect(e.member_event_key).toBe("1");
    expect(e.source_policy_id).toBe("abuse.ch/feodo");
    expect(e.source_version).toBe("2026-06-04");
    expect(e.feed_hash).toBeTruthy();
    expect(e.hit_type).toBe("deterministic_ioc");
    expect(e.floor_eligible).toBe(true);
    expect(e.coverage_status).toBe("complete");
    expect(e.checked_at).toBeTruthy();
  });

  it("false-complete: answered, no hit → no evidence, coverage complete", async () => {
    await importFeodo(feedPool, FRESH);
    await seedStory(customerPool, "1002", { resp_addr: "45.66.230.99" });

    const result = await runStoryEnrichment(
      CUSTOMER_ID,
      "1002",
      opts(authPool, feedPool, customerPool),
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
      opts(authPool, feedPool, customerPool),
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
    await importFeodo(feedPool, FRESH);
    // The stored member text carries a token; the recovered value is a
    // public IP inside the (here simulated) customer-registered range, so
    // it is floor-eligible and listed in the feed.
    await seedStory(customerPool, "1004", { orig_addr: "<<REDACTED_IP_001>>" });

    const result = await runStoryEnrichment(
      CUSTOMER_ID,
      "1004",
      opts(authPool, feedPool, customerPool, {
        loadRedactionMap: async () => ({
          "<<REDACTED_IP_001>>": { kind: "ip", value: "45.66.230.5" },
        }),
      }),
    );
    expect(result.knownIocHit).toBe(true);
    expect(result.evidenceCount).toBe(1);

    const { rows: ev } = await customerPool.query<{
      redaction_token: string;
      source_aice_id: string;
      member_event_key: string;
    }>(
      `SELECT redaction_token, source_aice_id,
              member_event_key::text AS member_event_key
         FROM story_ioc_evidence
        WHERE story_id = 1004 AND story_version = 'v1'`,
    );
    // Customer-asset indicator → the TOKEN is the evidence reference, and the
    // recovered raw value lives ONLY in the redaction map, never in the row.
    expect(ev[0].redaction_token).toBe("<<REDACTED_IP_001>>");
    expect(JSON.stringify(ev[0])).not.toContain("45.66.230.5");
    // The row also carries the `(aice_id, event_key)` map scope that recovers
    // the token — without it the token alone would be ambiguous.
    expect(ev[0].source_aice_id).toBe(AICE_ID);
    expect(ev[0].member_event_key).toBe("1");
  });

  it("distinguishes two members reusing the same token for different IPs", async () => {
    // Two members of one story each carry `<<REDACTED_IP_001>>`, but token
    // numbering restarts per event, so the two tokens recover DIFFERENT
    // customer-asset IPs from their own event_redaction_map rows. Both IPs
    // are floor-eligible feed hits, so each produces an evidence row. With
    // only the token string the two rows would be indistinguishable and the
    // originals unrecoverable; the `(source_aice_id, member_event_key)` scope
    // ties each row to the map that recovers it.
    await importFeedSnapshot(feedPool, {
      sourcePolicyId: "abuse.ch/feodo",
      entityType: "IP",
      hitType: "deterministic_ioc",
      classification: "c2",
      sourceVersion: "2026-06-04",
      sourceUpdatedAt: FRESH,
      rows: [{ matchValue: "45.66.230.5" }, { matchValue: "45.66.230.6" }],
    });
    await customerPool.query(
      `INSERT INTO story
         (story_id, story_version, kind, time_window_start, time_window_end,
          summary_payload, source_aice_id, received_at)
       VALUES (1011::bigint, 'v1', 'auto_correlated',
               '2026-05-01T00:00:00Z', '2026-05-01T01:00:00Z',
               '{}'::jsonb, $1, '2026-05-01T02:00:00Z')`,
      [AICE_ID],
    );
    for (const eventKey of ["1", "2"]) {
      await customerPool.query(
        `INSERT INTO story_member
           (story_id, story_version, member_event_key, role, event,
            redaction_policy_version)
         VALUES (1011::bigint, 'v1', $1::numeric, 'primary', $2::jsonb,
                 'engine:1.0.0|ranges:empty')`,
        [eventKey, JSON.stringify({ orig_addr: "<<REDACTED_IP_001>>" })],
      );
    }

    // Same token, different recovered IP per event scope.
    const recovered: Record<string, string> = {
      "1": "45.66.230.5",
      "2": "45.66.230.6",
    };
    const result = await runStoryEnrichment(
      CUSTOMER_ID,
      "1011",
      opts(authPool, feedPool, customerPool, {
        loadRedactionMap: async (_pool, _cid, _aice, eventKey) => ({
          "<<REDACTED_IP_001>>": {
            kind: "ip",
            value: recovered[eventKey] ?? "0.0.0.0",
          },
        }),
      }),
    );
    expect(result.knownIocHit).toBe(true);
    expect(result.evidenceCount).toBe(2);

    const { rows: ev } = await customerPool.query<{
      redaction_token: string;
      member_event_key: string;
    }>(
      `SELECT redaction_token, member_event_key::text AS member_event_key
         FROM story_ioc_evidence
        WHERE story_id = 1011 AND story_version = 'v1'
        ORDER BY member_event_key`,
    );
    expect(ev).toHaveLength(2);
    // Both rows carry the SAME ambiguous token string...
    expect(ev[0].redaction_token).toBe("<<REDACTED_IP_001>>");
    expect(ev[1].redaction_token).toBe("<<REDACTED_IP_001>>");
    // ...but are distinguishable by their map scope, so each original is
    // recoverable from its own event_redaction_map row.
    expect(ev[0].member_event_key).toBe("1");
    expect(ev[1].member_event_key).toBe("2");
    // No recovered customer-asset IP ever lands in the evidence rows.
    expect(JSON.stringify(ev)).not.toContain("45.66.230.5");
    expect(JSON.stringify(ev)).not.toContain("45.66.230.6");
  });

  it("extracts an IOC present only in the policy_event typed columns", async () => {
    await importFeodo(feedPool, FRESH);
    // The member JSONB carries NO indicator; the IOC lives only in the
    // discrete policy_event.resp_addr column for the same event_key. A
    // worker that read story_member.event alone would mark the story
    // complete with known_ioc_hit=false and never flip the floor.
    await seedStory(customerPool, "1007", { note: "no indicator in JSONB" });
    await seedPolicyEvent(customerPool, "5001", { resp_addr: "45.66.230.5" });

    const result = await runStoryEnrichment(
      CUSTOMER_ID,
      "1007",
      opts(authPool, feedPool, customerPool),
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
    await importFeodo(feedPool, FRESH);
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
      opts(authPool, feedPool, customerPool, {
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

  it("does not inherit a policy_event IOC from a different source_aice_id", async () => {
    await importFeodo(feedPool, FRESH);
    // The story belongs to AICE_ID and has no indicator in its member JSONB.
    // A DIFFERENT source's policy_run/policy_event shares the same event_key
    // (1) and carries the IOC. Logical event identity is
    // (source_aice_id, event_key), so this row must NOT flip the floor for
    // a story owned by AICE_ID. An event_key-only read would.
    await seedStory(customerPool, "1009", { note: "no indicator in JSONB" });
    await seedPolicyEvent(
      customerPool,
      "5003",
      { resp_addr: "45.66.230.5" },
      "1",
      "aice-other",
    );

    const result = await runStoryEnrichment(
      CUSTOMER_ID,
      "1009",
      opts(authPool, feedPool, customerPool),
    );
    expect(result.knownIocHit).toBe(false);
    expect(result.evidenceCount).toBe(0);

    const { rows } = await customerPool.query<{ known_ioc_hit: boolean }>(
      `SELECT known_ioc_hit FROM story
        WHERE story_id = 1009 AND story_version = 'v1'`,
    );
    expect(rows[0].known_ioc_hit).toBe(false);

    // The SAME source's policy_event for the same event_key still flips it,
    // proving the scoping is by source, not a blanket event_key suppression.
    await seedPolicyEvent(customerPool, "5004", { resp_addr: "45.66.230.5" });
    const rerun = await runStoryEnrichment(
      CUSTOMER_ID,
      "1009",
      opts(authPool, feedPool, customerPool),
    );
    expect(rerun.knownIocHit).toBe(true);
  });

  it("preserves prior evidence when a rerun finds no current match (monotonic)", async () => {
    await importFeodo(feedPool, FRESH);
    await seedStory(customerPool, "1010", { resp_addr: "45.66.230.5" });

    const first = await runStoryEnrichment(
      CUSTOMER_ID,
      "1010",
      opts(authPool, feedPool, customerPool),
    );
    expect(first.knownIocHit).toBe(true);
    expect(first.evidenceCount).toBe(1);

    // The feed snapshot becomes unavailable before a rerun: no current
    // supporting match, coverage degrades to unknown. The boolean is
    // monotonic so the hit is retained — and the evidence that explains it
    // must NOT be erased, or a `true` floor would have nothing backing it.
    await feedPool.query("DELETE FROM ioc_feed_snapshot");
    const second = await runStoryEnrichment(
      CUSTOMER_ID,
      "1010",
      opts(authPool, feedPool, customerPool),
    );
    expect(second.knownIocHit).toBe(false); // this run observed no hit
    expect(second.coverageStatus).toBe("unknown");

    // story + state stay true (monotonic OR).
    const { rows: storyRows } = await customerPool.query<{
      known_ioc_hit: boolean;
    }>(
      `SELECT known_ioc_hit FROM story
        WHERE story_id = 1010 AND story_version = 'v1'`,
    );
    expect(storyRows[0].known_ioc_hit).toBe(true);

    // The prior evidence row survives the rerun — auditability preserved.
    const { rows: ev } = await customerPool.query<{ redaction_token: string }>(
      `SELECT redaction_token FROM story_ioc_evidence
        WHERE story_id = 1010 AND story_version = 'v1'`,
    );
    expect(ev).toHaveLength(1);
    expect(ev[0].redaction_token).toBe("45.66.230.5");
  });

  it("persists a visible, recoverable failed marker on a hard enrichment failure", async () => {
    await importFeodo(feedPool, FRESH);
    await seedStory(customerPool, "1012", { resp_addr: "45.66.230.5" });

    // A hard failure reached AFTER the canonical version is known — here the
    // dispatcher build throws, standing in for a config/decryption/DB error.
    // Without a marker this would requeue analysis forever with only process
    // logs to explain it.
    const failing = opts(authPool, feedPool, customerPool, {
      buildDispatcher: () => {
        throw new Error("boom: dispatcher unavailable");
      },
    });
    await expect(
      runStoryEnrichment(CUSTOMER_ID, "1012", failing),
    ).rejects.toThrow(/boom/);

    // The stall is now visible in the customer DB.
    const { rows } = await customerPool.query<{
      status: string;
      last_error: string | null;
      known_ioc_hit: boolean;
    }>(
      `SELECT status, last_error, known_ioc_hit FROM story_enrichment_state
        WHERE story_id = 1012 AND story_version = 'v1'`,
    );
    expect(rows[0].status).toBe("failed");
    expect(rows[0].last_error).toMatch(/boom/);
    expect(rows[0].known_ioc_hit).toBe(false);

    // Recoverable: a later successful run flips failed → complete.
    const ok = await runStoryEnrichment(
      CUSTOMER_ID,
      "1012",
      opts(authPool, feedPool, customerPool),
    );
    expect(ok.knownIocHit).toBe(true);

    // Monotonic-safe: a later transient failure must NOT downgrade an
    // already-complete enrichment or erase its observed hit (only record
    // the diagnostic last_error).
    await expect(
      runStoryEnrichment(CUSTOMER_ID, "1012", failing),
    ).rejects.toThrow(/boom/);
    const { rows: stable } = await customerPool.query<{
      status: string;
      known_ioc_hit: boolean;
      last_error: string | null;
    }>(
      `SELECT status, known_ioc_hit, last_error FROM story_enrichment_state
        WHERE story_id = 1012 AND story_version = 'v1'`,
    );
    expect(stable[0].status).toBe("complete");
    expect(stable[0].known_ioc_hit).toBe(true);
    expect(stable[0].last_error).toMatch(/boom/);
  });

  it("seeds the pinned fixture feeds and matches a fixture IP via PgFeedStore", async () => {
    await seedFixtureFeeds(feedPool, { sourceUpdatedAt: FRESH });
    const store = new PgFeedStore(feedPool);

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

    // A bare domain (e.g. a story's dns_query) matches the URLhaus host
    // imported as a DOMAIN row — would miss if only full URLs were seeded.
    const domainHit = await store.match(
      "abuse.ch/urlhaus",
      normalizeDomain("malware.example"),
    );
    expect(domainHit.length).toBeGreaterThan(0);
    expect(domainHit[0].hitType).toBe("deterministic_ioc");

    // A different host under the same apex must NOT match (host-exact, not
    // registered-domain): URLhaus seeds `c2.example.test`, not `*.example.test`.
    const siblingMiss = await store.match(
      "abuse.ch/urlhaus",
      normalizeDomain("mail.example.test"),
    );
    expect(siblingMiss).toHaveLength(0);

    // URLhaus payloads dump matches a fixture file hash (MD5 and SHA-256),
    // case-insensitively — the HASH entity type a story member can carry.
    const sha256Hit = await store.match(
      "abuse.ch/urlhaus-payloads",
      normalizeHash(
        "0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF",
      ),
    );
    expect(sha256Hit.length).toBeGreaterThan(0);
    expect(sha256Hit[0].hitType).toBe("deterministic_ioc");

    const md5Hit = await store.match(
      "abuse.ch/urlhaus-payloads",
      normalizeHash("fedcba9876543210fedcba9876543210"),
    );
    expect(md5Hit.length).toBeGreaterThan(0);
  });

  it("tickStoryEnrichmentOnce enriches stories with a queued analysis job", async () => {
    await importFeodo(feedPool, FRESH);
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
      opts(authPool, feedPool, customerPool),
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
      opts(authPool, feedPool, customerPool),
    );
    expect(again).toBe(0);
  });

  it("a stale feed still reports the hit (boolean monotonic) but coverage is stale", async () => {
    await importFeodo(feedPool, STALE);
    await seedStory(customerPool, "1005", { resp_addr: "45.66.230.5" });

    const result = await runStoryEnrichment(
      CUSTOMER_ID,
      "1005",
      opts(authPool, feedPool, customerPool),
    );
    expect(result.knownIocHit).toBe(true);
    expect(result.coverageStatus).toBe("stale");
  });

  // -------------------------------------------------------------------------
  // #589 — soft / non-floor evidence + meaningfulness gate
  // -------------------------------------------------------------------------

  it("always promotes a floor-ineligible deterministic hit as evidence-only", async () => {
    // A curated known-bad (deterministic_ioc) hit from a floorEligible:false
    // source — the shipped posture. It is ALWAYS promoted to evidence (not
    // subject to the gate), but is evidence-only: it never flips the floor.
    await importFeodo(feedPool, FRESH);
    await seedStory(customerPool, "1101", { resp_addr: "45.66.230.5" });

    const result = await runStoryEnrichment(
      CUSTOMER_ID,
      "1101",
      optsWithPolicies(authPool, feedPool, customerPool, NONFLOORING_DET),
    );
    expect(result.knownIocHit).toBe(false);
    expect(result.evidenceCount).toBe(1);

    const { rows: ev } = await customerPool.query<{
      hit_type: string;
      floor_eligible: boolean;
      source_policy_id: string;
    }>(
      `SELECT hit_type, floor_eligible, source_policy_id
         FROM story_ioc_evidence
        WHERE story_id = 1101 AND story_version = 'v1'`,
    );
    expect(ev).toHaveLength(1);
    expect(ev[0].hit_type).toBe("deterministic_ioc");
    expect(ev[0].floor_eligible).toBe(false);
    expect(ev[0].source_policy_id).toBe("abuse.ch/feodo");

    // The floor is untouched.
    const { rows } = await customerPool.query<{ known_ioc_hit: boolean }>(
      `SELECT known_ioc_hit FROM story
        WHERE story_id = 1101 AND story_version = 'v1'`,
    );
    expect(rows[0].known_ioc_hit).toBe(false);
  });

  it("only-soft (above gate): promotes soft evidence, keeps known_ioc_hit false", async () => {
    // A soft-reputation match above the confidence threshold is promoted to a
    // structured evidence row (floor_eligible:false, hit_type:soft_reputation)
    // but NEVER flips known_ioc_hit or changes coverage — the floor invariant.
    await importSoft(feedPool, SOFT_A.sourcePolicyId, 0.9);
    await seedStory(customerPool, "1102", { resp_addr: "45.66.230.5" });

    const result = await runStoryEnrichment(
      CUSTOMER_ID,
      "1102",
      optsWithPolicies(authPool, feedPool, customerPool, [SOFT_A]),
    );
    expect(result.knownIocHit).toBe(false);
    expect(result.evidenceCount).toBe(1);

    const { rows: ev } = await customerPool.query<{
      hit_type: string;
      floor_eligible: boolean;
      source_policy_id: string;
    }>(
      `SELECT hit_type, floor_eligible, source_policy_id
         FROM story_ioc_evidence
        WHERE story_id = 1102 AND story_version = 'v1'`,
    );
    expect(ev).toHaveLength(1);
    expect(ev[0].hit_type).toBe("soft_reputation");
    expect(ev[0].floor_eligible).toBe(false);
    // Citation DATA: the row carries source_policy_id, resolvable to a label
    // via the source registry/policy (the consumer rendering is the #591
    // follow-up; only the data is asserted here).
    expect(ev[0].source_policy_id).toBe(SOFT_A.sourcePolicyId);
    expect(SOFT_A.label).toBeTruthy();

    const { rows } = await customerPool.query<{ known_ioc_hit: boolean }>(
      `SELECT known_ioc_hit FROM story
        WHERE story_id = 1102 AND story_version = 'v1'`,
    );
    expect(rows[0].known_ioc_hit).toBe(false);
  });

  it("promotes a below-threshold soft match corroborated by >= 2 sources", async () => {
    // Two distinct soft sources hit the same indicator, each below the
    // confidence threshold. Multi-source corroboration promotes them anyway.
    await importSoft(feedPool, SOFT_A.sourcePolicyId, 0.1);
    await importSoft(feedPool, SOFT_B.sourcePolicyId, 0.1);
    await seedStory(customerPool, "1103", { resp_addr: "45.66.230.5" });

    const result = await runStoryEnrichment(
      CUSTOMER_ID,
      "1103",
      optsWithPolicies(authPool, feedPool, customerPool, [SOFT_A, SOFT_B]),
    );
    expect(result.knownIocHit).toBe(false);
    expect(result.evidenceCount).toBe(2);

    const { rows: ev } = await customerPool.query<{ source_policy_id: string }>(
      `SELECT source_policy_id FROM story_ioc_evidence
        WHERE story_id = 1103 AND story_version = 'v1'
        ORDER BY source_policy_id`,
    );
    expect(ev.map((r) => r.source_policy_id)).toEqual([
      SOFT_A.sourcePolicyId,
      SOFT_B.sourcePolicyId,
    ]);
  });

  it("below-gate soft: leaves the fact (primes the LLM) but writes no evidence row", async () => {
    // The fact / LLM-priming channel is UNGATED (#440): a sub-threshold,
    // single-source soft match still produces its fact, while it produces NO
    // structured evidence row, and the not-promoted decision is logged.
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      await importSoft(feedPool, SOFT_A.sourcePolicyId, 0.1);
      await seedStory(customerPool, "1104", { resp_addr: "45.66.230.5" });

      const result = await runStoryEnrichment(
        CUSTOMER_ID,
        "1104",
        optsWithPolicies(authPool, feedPool, customerPool, [SOFT_A]),
      );
      expect(result.evidenceCount).toBe(0);
      expect(result.factCount).toBe(1);

      // No structured evidence row.
      const { rows: ev } = await customerPool.query(
        `SELECT 1 FROM story_ioc_evidence
          WHERE story_id = 1104 AND story_version = 'v1'`,
      );
      expect(ev).toHaveLength(0);

      // The fact is still persisted (unchanged from #440).
      const { rows: facts } = await customerPool.query<{ fact_text: string }>(
        `SELECT fact_text FROM story_enrichment_fact
          WHERE story_id = 1104 AND story_version = 'v1'`,
      );
      expect(facts).toHaveLength(1);
      expect(facts[0].fact_text).toContain("45.66.230.5");

      // The not-promoted decision is observable, without leaking the indicator.
      expect(infoSpy).toHaveBeenCalled();
      const logged = infoSpy.mock.calls.find((c) =>
        String(c[0]).includes("not promoted to"),
      );
      expect(logged).toBeTruthy();
      expect(JSON.stringify(logged)).not.toContain("45.66.230.5");
    } finally {
      infoSpy.mockRestore();
    }
  });

  it("preserves prior floor evidence on a non-floor-only rerun (monotonic)", async () => {
    // Run 1: a floor-eligible deterministic hit → floor evidence + true floor.
    await importFeodo(feedPool, FRESH);
    await seedStory(customerPool, "1105", { resp_addr: "45.66.230.5" });
    const first = await runStoryEnrichment(
      CUSTOMER_ID,
      "1105",
      opts(authPool, feedPool, customerPool),
    );
    expect(first.knownIocHit).toBe(true);
    expect(first.evidenceCount).toBe(1);

    // Run 2: only a soft match remains (the deterministic feed is gone). The
    // run produces non-floor evidence only — it must NOT delete the prior
    // floor row, and the monotonic floor stays true.
    await feedPool.query("DELETE FROM ioc_feed_snapshot");
    await importSoft(feedPool, SOFT_A.sourcePolicyId, 0.9);
    const second = await runStoryEnrichment(
      CUSTOMER_ID,
      "1105",
      optsWithPolicies(authPool, feedPool, customerPool, [SOFT_A]),
    );
    expect(second.knownIocHit).toBe(false);

    const { rows } = await customerPool.query<{ known_ioc_hit: boolean }>(
      `SELECT known_ioc_hit FROM story
        WHERE story_id = 1105 AND story_version = 'v1'`,
    );
    expect(rows[0].known_ioc_hit).toBe(true); // monotonic

    // Both the preserved floor row and the new soft row are present.
    const { rows: ev } = await customerPool.query<{
      hit_type: string;
      floor_eligible: boolean;
    }>(
      `SELECT hit_type, floor_eligible FROM story_ioc_evidence
        WHERE story_id = 1105 AND story_version = 'v1'
        ORDER BY hit_type`,
    );
    expect(ev).toHaveLength(2);
    expect(ev).toContainEqual({
      hit_type: "deterministic_ioc",
      floor_eligible: true,
    });
    expect(ev).toContainEqual({
      hit_type: "soft_reputation",
      floor_eligible: false,
    });
  });

  it("clears stale non-floor rows on a successful zero-evidence rerun, keeps floor", async () => {
    // Run 1 persists a floor row AND a soft non-floor row.
    await importFeodo(feedPool, FRESH);
    await importSoft(feedPool, SOFT_A.sourcePolicyId, 0.9);
    await seedStory(customerPool, "1106", { resp_addr: "45.66.230.5" });
    const first = await runStoryEnrichment(
      CUSTOMER_ID,
      "1106",
      optsWithPolicies(authPool, feedPool, customerPool, [...FLOORING, SOFT_A]),
    );
    expect(first.knownIocHit).toBe(true);
    expect(first.evidenceCount).toBe(2);

    // Run 2 completes successfully with ZERO matches (all feeds gone). The
    // non-floor delete is NOT gated on evidence count, so the stale soft row
    // is cleared; the floor row is preserved and the floor stays true.
    await feedPool.query("DELETE FROM ioc_feed_snapshot");
    const second = await runStoryEnrichment(
      CUSTOMER_ID,
      "1106",
      optsWithPolicies(authPool, feedPool, customerPool, [...FLOORING, SOFT_A]),
    );
    expect(second.status).toBe("complete");
    expect(second.evidenceCount).toBe(0);

    const { rows: ev } = await customerPool.query<{
      hit_type: string;
      floor_eligible: boolean;
    }>(
      `SELECT hit_type, floor_eligible FROM story_ioc_evidence
        WHERE story_id = 1106 AND story_version = 'v1'`,
    );
    expect(ev).toHaveLength(1);
    expect(ev[0].hit_type).toBe("deterministic_ioc");
    expect(ev[0].floor_eligible).toBe(true);

    const { rows } = await customerPool.query<{ known_ioc_hit: boolean }>(
      `SELECT known_ioc_hit FROM story
        WHERE story_id = 1106 AND story_version = 'v1'`,
    );
    expect(rows[0].known_ioc_hit).toBe(true);
  });
});
