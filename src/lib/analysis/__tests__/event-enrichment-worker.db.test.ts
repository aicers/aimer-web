// RFC 0003 consumer ④ (#492) — per-event IOC enrichment integration
// (cross-DB).
//
// Drives `runEventEnrichment` against a real customer DB (baseline_event /
// story / event evidence + state) and a real auth DB (ioc_feed_snapshot),
// covering the acceptance criteria:
//   - floor-eligible deterministic hit → stored true verdict + evidence,
//   - false-complete (answered, no hit) vs false-unknown (missing feed),
//   - a non-floor-eligible match (non-public IP) produces NO evidence and
//     NO tier-A-qualifying verdict,
//   - latest baseline_event by received_at wins across baseline_versions,
//   - a prior true verdict is not downgraded by a source-down re-check,
//   - a story-member event is skipped (no event-scope double-work),
//   - redaction-map recovery of a tokenized customer-asset IP,
//   - a hard failure leaves a visible, recoverable failed marker,
//   - readiness + verdict read from one snapshot via the verdict helper.
//
// Feeds use a floor-eligible policy set (simulating a license-cleared feed);
// the SHIPPED policies are floorEligible:false. Indicators use genuine
// public-unicast IPs (RFC 5737 doc ranges classify as `reserved` →
// non-public → never floor-eligible), except where a non-public IP is the
// point under test.

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
import { buildLocalFeedDispatcher } from "../enrichment/local-feed-enricher";
import type { SourcePolicy } from "../enrichment/source-policy";
import {
  type EventEnrichmentOptions,
  loadEventEnrichmentVerdict,
  runEventEnrichment,
} from "../event-enrichment-worker";

const AUTH_MIGRATIONS_DIR = join(process.cwd(), "migrations", "auth");
const CUSTOMER_MIGRATIONS_DIR = join(process.cwd(), "migrations", "customer");
const AUTH_LOCK_ID = 2611;
const CUSTOMER_LOCK_ID = 2612;
const CUSTOMER_ID = "00000000-0000-0000-0000-0000000004a1";
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
  customerPool: Pool,
  overrides: Partial<EventEnrichmentOptions> = {},
): EventEnrichmentOptions {
  return {
    authPool,
    resolveCustomerPool: () => customerPool,
    now: () => new Date(NOW),
    buildDispatcher: (ap, now) =>
      buildLocalFeedDispatcher(new PgFeedStore(ap), {
        now,
        policies: FLOORING,
      }),
    ...overrides,
  };
}

async function seedBaselineEvent(
  customerPool: Pool,
  args: {
    eventKey: string;
    rawEvent: unknown;
    baselineVersion?: string;
    receivedAt?: string;
    sourceAiceId?: string;
  },
): Promise<void> {
  await customerPool.query(
    `INSERT INTO baseline_event
       (baseline_version, event_key, event_time, kind, raw_score,
        raw_event, score_window_context, window_signals,
        scoring_weights_snapshot, source_aice_id, received_at)
     VALUES ($1, $2::numeric, '2026-05-01T00:00:00Z', 'conn', 1.0,
             $3::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, $4,
             $5::timestamptz)`,
    [
      args.baselineVersion ?? "bv1",
      args.eventKey,
      JSON.stringify(args.rawEvent),
      args.sourceAiceId ?? AICE_ID,
      args.receivedAt ?? "2026-05-01T02:00:00Z",
    ],
  );
}

async function importFeodo(
  authPool: Pool,
  sourceUpdatedAt: string,
  matchValue = "45.66.230.5",
) {
  await importFeedSnapshot(authPool, {
    sourcePolicyId: "abuse.ch/feodo",
    entityType: "IP",
    hitType: "deterministic_ioc",
    classification: "c2",
    sourceVersion: "2026-06-04",
    sourceUpdatedAt,
    rows: [{ matchValue }],
  });
}

describe.skipIf(!hasPostgres)("per-event IOC enrichment (cross-DB)", () => {
  let authDbName: string;
  let authPool: Pool;
  let customerDbName: string;
  let customerPool: Pool;

  beforeAll(async () => {
    const auth = await createTestDatabase("evt_enrich_auth");
    authDbName = auth.dbName;
    authPool = auth.pool;
    await runMigrations(authPool, AUTH_MIGRATIONS_DIR, AUTH_LOCK_ID);

    const cust = await createTestDatabase("evt_enrich_cust");
    customerDbName = cust.dbName;
    customerPool = cust.pool;
    await runMigrations(
      customerPool,
      CUSTOMER_MIGRATIONS_DIR,
      CUSTOMER_LOCK_ID,
    );

    await authPool.query(
      `INSERT INTO customers (id, external_key, name, database_status, timezone)
       VALUES ($1, 'evt-enrich', 'Event Enrich', 'active', 'Asia/Seoul')`,
      [CUSTOMER_ID],
    );
  }, 60_000);

  afterAll(async () => {
    await dropTestDatabase(authDbName, authPool);
    await dropTestDatabase(customerDbName, customerPool);
    await closeAdminPool();
  }, 30_000);

  beforeEach(async () => {
    await customerPool.query("DELETE FROM baseline_event");
    await customerPool.query("DELETE FROM story");
    await customerPool.query("DELETE FROM event_enrichment_state");
    await customerPool.query("DELETE FROM event_ioc_evidence");
    await authPool.query("DELETE FROM ioc_feed_snapshot");
  });

  it("floor-eligible hit → true verdict + evidence + readable state", async () => {
    await importFeodo(authPool, FRESH);
    await seedBaselineEvent(customerPool, {
      eventKey: "1",
      rawEvent: { resp_addr: "45.66.230.5" },
    });

    const result = await runEventEnrichment(
      CUSTOMER_ID,
      AICE_ID,
      "1",
      opts(authPool, customerPool),
    );
    expect(result.status).toBe("complete");
    expect(result.knownIocHit).toBe(true);
    expect(result.coverageStatus).toBe("complete");
    expect(result.evidenceCount).toBe(1);

    // Readiness + verdict from one snapshot.
    const verdict = await loadEventEnrichmentVerdict(
      customerPool,
      AICE_ID,
      "1",
    );
    expect(verdict).not.toBeNull();
    expect(verdict?.status).toBe("complete");
    expect(verdict?.coverageStatus).toBe("complete");
    expect(verdict?.knownIocHit).toBe(true);
    expect(verdict?.completedAt).toBeTruthy();

    // Evidence row mirrors story_ioc_evidence, keyed by (source_aice_id,
    // event_key), external indicator stored RAW.
    const { rows: ev } = await customerPool.query<{
      source_aice_id: string;
      event_key: string;
      redaction_token: string;
      source_policy_id: string;
      hit_type: string;
      floor_eligible: boolean;
      coverage_status: string;
    }>(
      `SELECT source_aice_id, event_key::text AS event_key, redaction_token,
              source_policy_id, hit_type, floor_eligible, coverage_status
         FROM event_ioc_evidence
        WHERE source_aice_id = $1 AND event_key = 1`,
      [AICE_ID],
    );
    expect(ev).toHaveLength(1);
    expect(ev[0].source_aice_id).toBe(AICE_ID);
    expect(ev[0].event_key).toBe("1");
    expect(ev[0].redaction_token).toBe("45.66.230.5");
    expect(ev[0].source_policy_id).toBe("abuse.ch/feodo");
    expect(ev[0].hit_type).toBe("deterministic_ioc");
    expect(ev[0].floor_eligible).toBe(true);
    expect(ev[0].coverage_status).toBe("complete");
  });

  it("false-complete: answered, no hit → no evidence, coverage complete", async () => {
    await importFeodo(authPool, FRESH);
    await seedBaselineEvent(customerPool, {
      eventKey: "2",
      rawEvent: { resp_addr: "45.66.230.99" },
    });

    const result = await runEventEnrichment(
      CUSTOMER_ID,
      AICE_ID,
      "2",
      opts(authPool, customerPool),
    );
    expect(result.knownIocHit).toBe(false);
    expect(result.coverageStatus).toBe("complete");
    expect(result.evidenceCount).toBe(0);

    const verdict = await loadEventEnrichmentVerdict(
      customerPool,
      AICE_ID,
      "2",
    );
    expect(verdict?.status).toBe("complete");
    expect(verdict?.coverageStatus).toBe("complete");
    expect(verdict?.knownIocHit).toBe(false);
  });

  it("false-unknown: missing feed → coverage unknown, not silent false", async () => {
    // No importFeodo: the snapshot is absent → unavailable → unknown.
    await seedBaselineEvent(customerPool, {
      eventKey: "3",
      rawEvent: { resp_addr: "45.66.230.5" },
    });

    const result = await runEventEnrichment(
      CUSTOMER_ID,
      AICE_ID,
      "3",
      opts(authPool, customerPool),
    );
    expect(result.knownIocHit).toBe(false);
    expect(result.coverageStatus).toBe("unknown");

    // A false negative under non-complete coverage is distinguishable in
    // storage from the clean false-complete above.
    const verdict = await loadEventEnrichmentVerdict(
      customerPool,
      AICE_ID,
      "3",
    );
    expect(verdict?.status).toBe("complete");
    expect(verdict?.coverageStatus).toBe("unknown");
    expect(verdict?.knownIocHit).toBe(false);
  });

  it("non-floor-eligible match (non-public IP) → no evidence, no verdict", async () => {
    // A doc-range IP (RFC 5737) is reserved → non-public → floorEligible
    // forced false. It IS listed in the feed (so a match occurs and coverage
    // is complete), but the match does not satisfy the floor, so no evidence
    // and no tier-A-qualifying verdict.
    await importFeodo(authPool, FRESH, "203.0.113.10");
    await seedBaselineEvent(customerPool, {
      eventKey: "4",
      rawEvent: { resp_addr: "203.0.113.10" },
    });

    const result = await runEventEnrichment(
      CUSTOMER_ID,
      AICE_ID,
      "4",
      opts(authPool, customerPool),
    );
    expect(result.knownIocHit).toBe(false);
    expect(result.evidenceCount).toBe(0);
    expect(result.coverageStatus).toBe("complete");

    const { rows } = await customerPool.query(
      `SELECT 1 FROM event_ioc_evidence
        WHERE source_aice_id = $1 AND event_key = 4`,
      [AICE_ID],
    );
    expect(rows).toHaveLength(0);
  });

  it("soft-reputation match → no evidence, no tier-A-qualifying verdict", async () => {
    // A `soft_reputation` hit on a genuine public IP: the match IS found
    // (coverage complete) and the policy is floor-eligible, but the floor
    // turns on `hitType === "deterministic_ioc"`, so a soft hit never enters
    // evidence and never qualifies tier A — a branch distinct from the
    // non-public-IP (floor-ineligible) case above.
    await importFeedSnapshot(authPool, {
      sourcePolicyId: "abuse.ch/feodo",
      entityType: "IP",
      hitType: "soft_reputation",
      classification: "suspicious",
      sourceVersion: "2026-06-04",
      sourceUpdatedAt: FRESH,
      rows: [{ matchValue: "45.66.230.5" }],
    });
    await seedBaselineEvent(customerPool, {
      eventKey: "11",
      rawEvent: { resp_addr: "45.66.230.5" },
    });

    const result = await runEventEnrichment(
      CUSTOMER_ID,
      AICE_ID,
      "11",
      opts(authPool, customerPool),
    );
    expect(result.knownIocHit).toBe(false);
    expect(result.evidenceCount).toBe(0);
    expect(result.coverageStatus).toBe("complete");

    const { rows } = await customerPool.query(
      `SELECT 1 FROM event_ioc_evidence
        WHERE source_aice_id = $1 AND event_key = 11`,
      [AICE_ID],
    );
    expect(rows).toHaveLength(0);
  });

  it("computes the verdict from the latest baseline_event by received_at", async () => {
    await importFeodo(authPool, FRESH);
    // Older row (no IOC) under one baseline_version; newer row (IOC) under a
    // later baseline_version with a later received_at. The latest row wins.
    await seedBaselineEvent(customerPool, {
      eventKey: "5",
      baselineVersion: "bv1",
      receivedAt: "2026-05-01T00:00:00Z",
      rawEvent: { resp_addr: "45.66.230.99" },
    });
    await seedBaselineEvent(customerPool, {
      eventKey: "5",
      baselineVersion: "bv2",
      receivedAt: "2026-05-02T00:00:00Z",
      rawEvent: { resp_addr: "45.66.230.5" },
    });

    const result = await runEventEnrichment(
      CUSTOMER_ID,
      AICE_ID,
      "5",
      opts(authPool, customerPool),
    );
    expect(result.knownIocHit).toBe(true);
    expect(result.evidenceCount).toBe(1);
  });

  it("breaks an equal-received_at tie by baseline_version DESC", async () => {
    await importFeodo(authPool, FRESH);
    // Two rows for the same event with IDENTICAL received_at: the lower
    // baseline_version has no IOC, the higher one does. The DDL-mandated
    // deterministic tie-break (baseline_version DESC) must select the higher
    // version, so the verdict is the hit. If the tie fell through to the
    // lower version the verdict would be a clean miss.
    await seedBaselineEvent(customerPool, {
      eventKey: "12",
      baselineVersion: "bv1",
      receivedAt: "2026-05-02T00:00:00Z",
      rawEvent: { resp_addr: "45.66.230.99" },
    });
    await seedBaselineEvent(customerPool, {
      eventKey: "12",
      baselineVersion: "bv2",
      receivedAt: "2026-05-02T00:00:00Z",
      rawEvent: { resp_addr: "45.66.230.5" },
    });

    const result = await runEventEnrichment(
      CUSTOMER_ID,
      AICE_ID,
      "12",
      opts(authPool, customerPool),
    );
    expect(result.knownIocHit).toBe(true);
    expect(result.evidenceCount).toBe(1);
  });

  it("serializes concurrent persists — no duplicate evidence", async () => {
    await importFeodo(authPool, FRESH);
    await seedBaselineEvent(customerPool, {
      eventKey: "13",
      rawEvent: { resp_addr: "45.66.230.5" },
    });

    // Two overlapping runs for the same (source_aice_id, event_key). The
    // transaction-scoped advisory lock in the persist path serializes the
    // evidence replace + state upsert, so the floor-supporting match lands
    // exactly once instead of being inserted by both runs (there is no
    // uniqueness constraint on event_ioc_evidence to dedupe it otherwise).
    const [a, b] = await Promise.all([
      runEventEnrichment(
        CUSTOMER_ID,
        AICE_ID,
        "13",
        opts(authPool, customerPool),
      ),
      runEventEnrichment(
        CUSTOMER_ID,
        AICE_ID,
        "13",
        opts(authPool, customerPool),
      ),
    ]);
    expect(a.knownIocHit).toBe(true);
    expect(b.knownIocHit).toBe(true);

    const { rows } = await customerPool.query(
      `SELECT 1 FROM event_ioc_evidence
        WHERE source_aice_id = $1 AND event_key = 13`,
      [AICE_ID],
    );
    expect(rows).toHaveLength(1);

    const verdict = await loadEventEnrichmentVerdict(
      customerPool,
      AICE_ID,
      "13",
    );
    expect(verdict?.knownIocHit).toBe(true);
    expect(verdict?.coverageStatus).toBe("complete");
  });

  it("does not downgrade a prior true verdict on a source-down re-check", async () => {
    await importFeodo(authPool, FRESH);
    await seedBaselineEvent(customerPool, {
      eventKey: "6",
      rawEvent: { resp_addr: "45.66.230.5" },
    });

    const first = await runEventEnrichment(
      CUSTOMER_ID,
      AICE_ID,
      "6",
      opts(authPool, customerPool),
    );
    expect(first.knownIocHit).toBe(true);
    expect(first.evidenceCount).toBe(1);

    // Feed snapshot disappears before the re-check: no current supporting
    // match, coverage degrades. The verdict is monotonic so it stays true,
    // and the evidence explaining it must survive.
    await authPool.query("DELETE FROM ioc_feed_snapshot");
    const second = await runEventEnrichment(
      CUSTOMER_ID,
      AICE_ID,
      "6",
      opts(authPool, customerPool),
    );
    expect(second.knownIocHit).toBe(false); // this run observed no hit
    expect(second.coverageStatus).toBe("unknown");

    const verdict = await loadEventEnrichmentVerdict(
      customerPool,
      AICE_ID,
      "6",
    );
    expect(verdict?.knownIocHit).toBe(true); // monotonic
    expect(verdict?.coverageStatus).toBe("unknown"); // latest run's coverage

    const { rows: ev } = await customerPool.query<{ redaction_token: string }>(
      `SELECT redaction_token FROM event_ioc_evidence
        WHERE source_aice_id = $1 AND event_key = 6`,
      [AICE_ID],
    );
    expect(ev).toHaveLength(1);
    expect(ev[0].redaction_token).toBe("45.66.230.5");
  });

  it("a stale feed still reports the hit but coverage is stale", async () => {
    await importFeodo(authPool, STALE);
    await seedBaselineEvent(customerPool, {
      eventKey: "7",
      rawEvent: { resp_addr: "45.66.230.5" },
    });

    const result = await runEventEnrichment(
      CUSTOMER_ID,
      AICE_ID,
      "7",
      opts(authPool, customerPool),
    );
    expect(result.knownIocHit).toBe(true);
    expect(result.coverageStatus).toBe("stale");
  });

  it("skips a story-member event (enriched at story scope, no double-work)", async () => {
    await importFeodo(authPool, FRESH);
    await seedBaselineEvent(customerPool, {
      eventKey: "8",
      rawEvent: { resp_addr: "45.66.230.5" },
    });
    // The same (source_aice_id, event_key) is a member of a story, so the
    // event-scope path must not touch it. Verified via the story ⋈
    // story_member join.
    await customerPool.query(
      `INSERT INTO story
         (story_id, story_version, kind, time_window_start, time_window_end,
          summary_payload, source_aice_id, received_at)
       VALUES (8001::bigint, 'v1', 'auto_correlated',
               '2026-05-01T00:00:00Z', '2026-05-01T01:00:00Z',
               '{}'::jsonb, $1, '2026-05-01T02:00:00Z')`,
      [AICE_ID],
    );
    await customerPool.query(
      `INSERT INTO story_member
         (story_id, story_version, member_event_key, role, event,
          redaction_policy_version)
       VALUES (8001::bigint, 'v1', 8::numeric, 'primary',
               '{"resp_addr":"45.66.230.5"}'::jsonb, 'engine:1.0.0')`,
    );

    const result = await runEventEnrichment(
      CUSTOMER_ID,
      AICE_ID,
      "8",
      opts(authPool, customerPool),
    );
    expect(result.status).toBe("skipped");
    expect(result.knownIocHit).toBe(false);

    // No event-scope state or evidence is written for a story member.
    const verdict = await loadEventEnrichmentVerdict(
      customerPool,
      AICE_ID,
      "8",
    );
    expect(verdict).toBeNull();
    const { rows } = await customerPool.query(
      `SELECT 1 FROM event_ioc_evidence
        WHERE source_aice_id = $1 AND event_key = 8`,
      [AICE_ID],
    );
    expect(rows).toHaveLength(0);

    // A member of a DIFFERENT source's story does not suppress this loose
    // event: the join is by (story.source_aice_id, member_event_key).
    await customerPool.query("UPDATE story SET source_aice_id = 'aice-other'");
    const rerun = await runEventEnrichment(
      CUSTOMER_ID,
      AICE_ID,
      "8",
      opts(authPool, customerPool),
    );
    expect(rerun.status).toBe("complete");
    expect(rerun.knownIocHit).toBe(true);
  });

  it("recovers a tokenized customer-asset IP via the redaction map", async () => {
    await importFeodo(authPool, FRESH);
    await seedBaselineEvent(customerPool, {
      eventKey: "9",
      rawEvent: { orig_addr: "<<REDACTED_IP_001>>" },
    });

    const result = await runEventEnrichment(
      CUSTOMER_ID,
      AICE_ID,
      "9",
      opts(authPool, customerPool, {
        loadRedactionMap: async () => ({
          "<<REDACTED_IP_001>>": { kind: "ip", value: "45.66.230.5" },
        }),
      }),
    );
    expect(result.knownIocHit).toBe(true);
    expect(result.evidenceCount).toBe(1);

    const { rows: ev } = await customerPool.query<{ redaction_token: string }>(
      `SELECT redaction_token FROM event_ioc_evidence
        WHERE source_aice_id = $1 AND event_key = 9`,
      [AICE_ID],
    );
    // The TOKEN is the evidence reference; the recovered raw value lives ONLY
    // in the redaction map, never in the row.
    expect(ev[0].redaction_token).toBe("<<REDACTED_IP_001>>");
    expect(JSON.stringify(ev[0])).not.toContain("45.66.230.5");
  });

  it("skips an event with no stored baseline_event row", async () => {
    const result = await runEventEnrichment(
      CUSTOMER_ID,
      AICE_ID,
      "404",
      opts(authPool, customerPool),
    );
    expect(result.status).toBe("skipped");
    const verdict = await loadEventEnrichmentVerdict(
      customerPool,
      AICE_ID,
      "404",
    );
    expect(verdict).toBeNull();
  });

  it("persists a visible, recoverable failed marker on a hard failure", async () => {
    await importFeodo(authPool, FRESH);
    await seedBaselineEvent(customerPool, {
      eventKey: "10",
      rawEvent: { resp_addr: "45.66.230.5" },
    });

    const failing = opts(authPool, customerPool, {
      buildDispatcher: () => {
        throw new Error("boom: dispatcher unavailable");
      },
    });
    await expect(
      runEventEnrichment(CUSTOMER_ID, AICE_ID, "10", failing),
    ).rejects.toThrow(/boom/);

    const failed = await loadEventEnrichmentVerdict(
      customerPool,
      AICE_ID,
      "10",
    );
    expect(failed?.status).toBe("failed");
    expect(failed?.knownIocHit).toBe(false);

    // Recoverable: a later successful run flips failed → complete.
    const ok = await runEventEnrichment(
      CUSTOMER_ID,
      AICE_ID,
      "10",
      opts(authPool, customerPool),
    );
    expect(ok.knownIocHit).toBe(true);

    // Monotonic-safe: a later transient failure must NOT downgrade an
    // already-complete enrichment or erase its observed hit.
    await expect(
      runEventEnrichment(CUSTOMER_ID, AICE_ID, "10", failing),
    ).rejects.toThrow(/boom/);
    const stable = await loadEventEnrichmentVerdict(
      customerPool,
      AICE_ID,
      "10",
    );
    expect(stable?.status).toBe("complete");
    expect(stable?.knownIocHit).toBe(true);
  });
});
