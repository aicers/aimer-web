import { join } from "node:path";
import type { Pool, PoolClient } from "pg";
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
} from "../../db/__tests__/db-test-helpers";
import { runMigrations } from "../../db/migrate";

// Set AUDIT_DATABASE_URL before importing the sweeper module so the
// audit pool is bound to our test audit DB. The auth pool used inside
// runRetentionTick is supplied via deps; the audit pool is the one
// `auditLog` resolves lazily via process.env.
const AUDIT_DATABASE_URL_BEFORE = process.env.AUDIT_DATABASE_URL;

const describeDb = hasPostgres ? describe : describe.skip;

describeDb("retention sweeper integration", () => {
  let authPool: Pool;
  let auditPool: Pool;
  let customerPool: Pool;
  let authDbName: string;
  let auditDbName: string;
  let customerDbName: string;
  let runRetentionTick: typeof import("../sweeper").runRetentionTick;
  let sweepCustomer: typeof import("../sweeper").sweepCustomer;

  // We need to keep references to the customer pool clients we hand
  // back so each `sweepCustomer` call shares the same Postgres
  // session lifecycle.
  async function customerConnect(): Promise<{
    query: PoolClient["query"];
    end: () => Promise<void>;
  }> {
    const client = await customerPool.connect();
    return {
      query: client.query.bind(client) as PoolClient["query"],
      end: async () => {
        client.release();
      },
    };
  }

  beforeAll(async () => {
    // Build the three test DBs in parallel-friendly order.
    const auth = await createTestDatabase("retsweep_auth", "auth");
    authDbName = auth.dbName;
    authPool = auth.pool;
    await runMigrations(
      authPool,
      join(process.cwd(), "migrations", "auth"),
      91000,
    );

    const audit = await createTestDatabase("retsweep_audit", "audit");
    auditDbName = audit.dbName;
    auditPool = audit.pool;
    auditPool.on("error", () => {
      // Swallow FATAL events emitted when dropTestDatabase
      // terminates backends after `auditLog` has lazily opened its
      // own pool against the same DB.
    });
    await runMigrations(
      auditPool,
      join(process.cwd(), "migrations", "audit"),
      91001,
    );
    // Bind the audit pool's URL into the env BEFORE we import the
    // sweeper so the singleton in `db/client.ts` resolves to our
    // test audit database.
    process.env.AUDIT_DATABASE_URL = audit.url;

    const customer = await createTestDatabase("retsweep_customer", "auth");
    customerDbName = customer.dbName;
    customerPool = customer.pool;
    await runMigrations(
      customerPool,
      join(process.cwd(), "migrations", "customer"),
      91002,
    );

    // Import the sweeper after AUDIT_DATABASE_URL is set so the
    // module's lazy audit-pool init picks up our test DB.
    const mod = await import("../sweeper");
    runRetentionTick = mod.runRetentionTick;
    sweepCustomer = mod.sweepCustomer;

    // The singleton audit pool inside `db/client.ts` is what
    // `auditLog` writes through; eagerly create it so we can attach
    // an error handler that swallows the FATAL emitted when
    // dropTestDatabase terminates its backends in afterAll.
    const { getAuditPool } = await import("../../db/client");
    getAuditPool().on("error", () => {});
  });

  afterAll(async () => {
    await dropTestDatabase(authDbName, authPool, "auth");
    await dropTestDatabase(auditDbName, auditPool, "audit");
    await dropTestDatabase(customerDbName, customerPool, "auth");
    await closeAdminPool();
    if (AUDIT_DATABASE_URL_BEFORE === undefined) {
      delete process.env.AUDIT_DATABASE_URL;
    } else {
      process.env.AUDIT_DATABASE_URL = AUDIT_DATABASE_URL_BEFORE;
    }
  });

  beforeEach(async () => {
    // Wipe per-test state in every DB so a previously-seeded
    // customer in auth_db cannot drive an extra sweep against the
    // shared customer-db pool.
    await customerPool.query("TRUNCATE TABLE detection_events");
    await customerPool.query("TRUNCATE TABLE baseline_event");
    await customerPool.query("TRUNCATE TABLE story_member, story CASCADE");
    await customerPool.query("TRUNCATE TABLE policy_event, policy_run CASCADE");
    await customerPool.query("TRUNCATE TABLE event_analysis_result");
    await customerPool.query("TRUNCATE TABLE event_redaction_map");
    await authPool.query(
      "TRUNCATE TABLE customer_retention_policy, customers CASCADE",
    );
    await auditPool.query("TRUNCATE TABLE audit_logs");
  });

  const NOW = new Date("2026-05-20T12:00:00Z");

  function daysAgo(d: number): Date {
    return new Date(NOW.getTime() - d * 86_400_000);
  }

  async function seedPolicy(
    customerId: string,
    externalKey: string,
    ingestionDays: number,
    analysisDays: number | null,
  ): Promise<void> {
    await authPool.query(
      `INSERT INTO customers (id, external_key, name, database_status)
       VALUES ($1, $2, 'cust', 'active')`,
      [customerId, externalKey],
    );
    await authPool.query(
      `INSERT INTO customer_retention_policy
         (customer_id, ingestion_days, analysis_days, updated_by)
       VALUES ($1, $2, $3, '00000000-0000-0000-0000-000000000000'::uuid)`,
      [customerId, ingestionDays, analysisDays],
    );
  }

  it("deletes only rows past their cutoff for the per-table sweep", async () => {
    const customerId = "11111111-1111-1111-1111-111111111111";
    await seedPolicy(customerId, "default", 365, 1095);

    // detection_events: one old (past 365d), one fresh.
    await customerPool.query(
      `INSERT INTO detection_events
         (aice_id, event_key, redacted_event, redaction_policy_version,
          schema_version, payload_hash, source, ingested_by, created_at)
       VALUES ('aice-old', 1, '{}', 'p', '1', 'h', 'manual', gen_random_uuid(), $1),
              ('aice-new', 2, '{}', 'p', '1', 'h', 'manual', gen_random_uuid(), $2)`,
      [daysAgo(400), daysAgo(10)],
    );

    // baseline_event: one old, one fresh.
    await customerPool.query(
      `INSERT INTO baseline_event
         (baseline_version, event_key, event_time, kind,
          raw_score, raw_event, score_window_context, window_signals,
          scoring_weights_snapshot, source_aice_id, received_at)
       VALUES ('v', 1, NOW(), 'http', 0, '{}', '{}', '{}', '{}', 'aice-old', $1),
              ('v', 2, NOW(), 'http', 0, '{}', '{}', '{}', '{}', 'aice-new', $2)`,
      [daysAgo(400), daysAgo(10)],
    );

    // event_analysis_result: one past analysis_days, one within.
    await customerPool.query(
      `INSERT INTO event_analysis_result
         (aice_id, event_key, lang, model_name, model,
          threat_score, analysis_text, redaction_policy_version,
          requested_by, requested_at)
       VALUES ('aice-old', 1, 'EN', 'openai', 'gpt-4o', 0, '', 'p',
               '00000000-0000-0000-0000-000000000000'::uuid, $1),
              ('aice-new', 2, 'EN', 'openai', 'gpt-4o', 0, '', 'p',
               '00000000-0000-0000-0000-000000000000'::uuid, $2)`,
      [daysAgo(2000), daysAgo(30)],
    );

    const outcome = await sweepCustomer(
      customerId,
      { ingestion_days: 365, analysis_days: 1095 },
      {
        authPool,
        connectCustomer: customerConnect,
      },
      NOW,
    );

    expect(outcome.status).toBe("completed");
    expect(outcome.counts.detection_events).toBe(1);
    expect(outcome.counts.baseline_event).toBe(1);
    expect(outcome.counts.event_analysis_result).toBe(1);

    const { rows: deRows } = await customerPool.query<{ aice_id: string }>(
      "SELECT aice_id FROM detection_events",
    );
    expect(deRows.map((r) => r.aice_id)).toEqual(["aice-new"]);

    const { rows: arRows } = await customerPool.query<{ aice_id: string }>(
      "SELECT aice_id FROM event_analysis_result",
    );
    expect(arRows.map((r) => r.aice_id)).toEqual(["aice-new"]);
  });

  it("cascades story_member when its parent story is past cutoff and counts children correctly", async () => {
    const customerId = "22222222-2222-2222-2222-222222222222";
    await seedPolicy(customerId, "cascade", 365, 1095);

    // One story past cutoff with two members; one story within
    // cutoff with one member.
    await customerPool.query(
      `INSERT INTO story
         (story_id, story_version, kind, time_window_start, time_window_end,
          summary_payload, source_aice_id, received_at)
       VALUES (1, 'v', 'auto_correlated', NOW(), NOW(), '{}', 'aice-1', $1),
              (2, 'v', 'auto_correlated', NOW(), NOW(), '{}', 'aice-2', $2)`,
      [daysAgo(400), daysAgo(10)],
    );
    await customerPool.query(
      `INSERT INTO story_member
         (story_id, story_version, member_event_key, role, event)
       VALUES (1, 'v', 11, 'primary', '{}'),
              (1, 'v', 12, 'context', '{}'),
              (2, 'v', 21, 'primary', '{}')`,
    );

    const outcome = await sweepCustomer(
      customerId,
      { ingestion_days: 365, analysis_days: 1095 },
      {
        authPool,
        connectCustomer: customerConnect,
      },
      NOW,
    );

    expect(outcome.status).toBe("completed");
    expect(outcome.counts.story).toBe(1);
    expect(outcome.counts.story_member).toBe(2);

    const { rows } = await customerPool.query<{ story_id: string }>(
      "SELECT story_id::text AS story_id FROM story",
    );
    expect(rows).toEqual([{ story_id: "2" }]);

    const { rows: members } = await customerPool.query<{ story_id: string }>(
      "SELECT story_id::text AS story_id FROM story_member",
    );
    expect(members).toEqual([{ story_id: "2" }]);
  });

  it("map cascade deletes only rows orphaned from BOTH referent sets", async () => {
    const customerId = "33333333-3333-3333-3333-333333333333";
    await seedPolicy(customerId, "map", 365, 1095);

    // Seed three map rows.
    await customerPool.query(
      `INSERT INTO event_redaction_map (aice_id, event_key, ciphertext, wrapped_dek)
       VALUES ('aice-a', 1, decode('00','hex'), 'w'),
              ('aice-b', 2, decode('00','hex'), 'w'),
              ('aice-c', 3, decode('00','hex'), 'w')`,
    );

    // aice-a: still referenced by baseline_event (within window).
    await customerPool.query(
      `INSERT INTO baseline_event
         (baseline_version, event_key, event_time, kind,
          raw_score, raw_event, score_window_context, window_signals,
          scoring_weights_snapshot, source_aice_id, received_at)
       VALUES ('v', 1, NOW(), 'http', 0, '{}', '{}', '{}', '{}', 'aice-a', $1)`,
      [daysAgo(10)],
    );

    // aice-b: still referenced by event_analysis_result (within window).
    await customerPool.query(
      `INSERT INTO event_analysis_result
         (aice_id, event_key, lang, model_name, model,
          threat_score, analysis_text, redaction_policy_version,
          requested_by, requested_at)
       VALUES ('aice-b', 2, 'EN', 'openai', 'gpt-4o', 0, '', 'p',
               '00000000-0000-0000-0000-000000000000'::uuid, $1)`,
      [daysAgo(30)],
    );

    // aice-c: no referent anywhere — must be deleted.
    const outcome = await sweepCustomer(
      customerId,
      { ingestion_days: 365, analysis_days: 1095 },
      {
        authPool,
        connectCustomer: customerConnect,
      },
      NOW,
    );

    expect(outcome.status).toBe("completed");
    expect(outcome.counts.event_redaction_map).toBe(1);

    const { rows } = await customerPool.query<{ aice_id: string }>(
      "SELECT aice_id FROM event_redaction_map ORDER BY aice_id",
    );
    expect(rows.map((r) => r.aice_id)).toEqual(["aice-a", "aice-b"]);
  });

  it("does not delete event_analysis_result when analysis_days is null", async () => {
    const customerId = "44444444-4444-4444-4444-444444444444";
    await seedPolicy(customerId, "unlim", 365, null);

    await customerPool.query(
      `INSERT INTO event_analysis_result
         (aice_id, event_key, lang, model_name, model,
          threat_score, analysis_text, redaction_policy_version,
          requested_by, requested_at)
       VALUES ('aice-x', 1, 'EN', 'openai', 'gpt-4o', 0, '', 'p',
               '00000000-0000-0000-0000-000000000000'::uuid, $1)`,
      [daysAgo(5000)],
    );

    const outcome = await sweepCustomer(
      customerId,
      { ingestion_days: 365, analysis_days: null },
      {
        authPool,
        connectCustomer: customerConnect,
      },
      NOW,
    );

    expect(outcome.status).toBe("completed");
    expect(outcome.counts.event_analysis_result).toBe(0);

    const { rows } = await customerPool.query<{ c: string }>(
      "SELECT COUNT(*) AS c FROM event_analysis_result",
    );
    expect(rows[0].c).toBe("1");
  });

  it("runRetentionTick skips non-active customers and emits tick_failed for missing policy", async () => {
    const activeId = "55555555-5555-5555-5555-555555555555";
    const inactiveId = "66666666-6666-6666-6666-666666666666";
    const missingPolicyId = "77777777-7777-7777-7777-777777777777";

    await seedPolicy(activeId, "act", 365, 1095);

    await authPool.query(
      `INSERT INTO customers (id, external_key, name, database_status)
       VALUES ($1, 'prov', 'cust', 'provisioning')`,
      [inactiveId],
    );

    // Active customer with NO policy row.
    await authPool.query(
      `INSERT INTO customers (id, external_key, name, database_status)
       VALUES ($1, 'no-pol', 'cust', 'active')`,
      [missingPolicyId],
    );
    await authPool.query(
      `DELETE FROM customer_retention_policy WHERE customer_id = $1`,
      [missingPolicyId],
    );

    // Track which customer IDs trigger connection attempts.
    const connectedIds: string[] = [];
    await runRetentionTick({
      authPool,
      connectCustomer: async (id) => {
        connectedIds.push(id);
        return customerConnect();
      },
      now: () => NOW,
    });

    // Only the active customer with policy should be connected.
    expect(connectedIds).toEqual([activeId]);

    const { rows: auditRows } = await auditPool.query<{
      action: string;
      target_id: string;
      details: { error_message?: string };
    }>(`SELECT action, target_id, details FROM audit_logs ORDER BY id`);
    const failed = auditRows.find(
      (r) =>
        r.action === "retention_sweep.tick_failed" &&
        r.target_id === missingPolicyId,
    );
    expect(failed?.details.error_message).toBe("missing_retention_policy");
    // No audit row for the provisioning customer.
    expect(auditRows.find((r) => r.target_id === inactiveId)).toBeUndefined();
  });

  it("writes tick_started and tick_completed audit rows for a customer with deletions", async () => {
    const customerId = "88888888-8888-8888-8888-888888888888";
    await seedPolicy(customerId, "with-audit", 365, 1095);

    await customerPool.query(
      `INSERT INTO detection_events
         (aice_id, event_key, redacted_event, redaction_policy_version,
          schema_version, payload_hash, source, ingested_by, created_at)
       VALUES ('aice-z', 1, '{}', 'p', '1', 'h', 'manual',
               gen_random_uuid(), $1)`,
      [daysAgo(400)],
    );

    await runRetentionTick({
      authPool,
      connectCustomer: customerConnect,
      now: () => NOW,
    });

    const { rows } = await auditPool.query<{
      action: string;
      details: { deleted_by_table?: { detection_events: number } };
    }>(
      `SELECT action, details FROM audit_logs
        WHERE target_id = $1
        ORDER BY id`,
      [customerId],
    );
    const actions = rows.map((r) => r.action);
    expect(actions).toEqual([
      "retention_sweep.tick_started",
      "retention_sweep.tick_completed",
    ]);
    expect(rows[1].details.deleted_by_table?.detection_events).toBe(1);
  });

  it("cascades policy_event when its parent policy_run is past cutoff and counts children correctly", async () => {
    const customerId = "99999999-9999-9999-9999-999999999999";
    await seedPolicy(customerId, "pe-cascade", 365, 1095);

    await customerPool.query(
      `INSERT INTO policy_run
         (run_id, period_start, period_end, created_at_source,
          baseline_version, policies_fingerprint, exclusions_fingerprint,
          status, source_aice_id, received_at)
       VALUES (10, NOW(), NOW(), NOW(), 'v', 'p', 'e', 'ready', 'aice-1', $1),
              (20, NOW(), NOW(), NOW(), 'v', 'p', 'e', 'ready', 'aice-2', $2)`,
      [daysAgo(400), daysAgo(10)],
    );
    await customerPool.query(
      `INSERT INTO policy_event
         (run_id, event_key, event_time, kind, policy_triage_snapshot)
       VALUES (10, 11, NOW(), 'http', '{}'),
              (10, 12, NOW(), 'http', '{}'),
              (10, 13, NOW(), 'http', '{}'),
              (20, 21, NOW(), 'http', '{}')`,
    );

    const outcome = await sweepCustomer(
      customerId,
      { ingestion_days: 365, analysis_days: 1095 },
      { authPool, connectCustomer: customerConnect },
      NOW,
    );

    expect(outcome.status).toBe("completed");
    expect(outcome.counts.policy_run).toBe(1);
    expect(outcome.counts.policy_event).toBe(3);

    const { rows: runs } = await customerPool.query<{ run_id: string }>(
      "SELECT run_id::text AS run_id FROM policy_run",
    );
    expect(runs).toEqual([{ run_id: "20" }]);
    const { rows: events } = await customerPool.query<{ run_id: string }>(
      "SELECT run_id::text AS run_id FROM policy_event",
    );
    expect(events).toEqual([{ run_id: "20" }]);
  });

  it("rolls back the whole tick when a sweep query fails mid-transaction", async () => {
    const customerId = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    await seedPolicy(customerId, "rollback", 365, 1095);

    // Two old rows that would normally be deleted.
    await customerPool.query(
      `INSERT INTO detection_events
         (aice_id, event_key, redacted_event, redaction_policy_version,
          schema_version, payload_hash, source, ingested_by, created_at)
       VALUES ('aice-old-1', 1, '{}', 'p', '1', 'h', 'manual',
               gen_random_uuid(), $1),
              ('aice-old-2', 2, '{}', 'p', '1', 'h', 'manual',
               gen_random_uuid(), $2)`,
      [daysAgo(400), daysAgo(410)],
    );
    await customerPool.query(
      `INSERT INTO baseline_event
         (baseline_version, event_key, event_time, kind,
          raw_score, raw_event, score_window_context, window_signals,
          scoring_weights_snapshot, source_aice_id, received_at)
       VALUES ('v', 1, NOW(), 'http', 0, '{}', '{}', '{}', '{}', 'aice-old-1', $1)`,
      [daysAgo(400)],
    );

    // Wrap connectCustomer so we can inject a failure on the baseline
    // DELETE — detection_events will have already deleted; the failure
    // must trigger ROLLBACK and the deletion must NOT persist.
    async function injectingConnect() {
      const inner = await customerConnect();
      const innerQuery = inner.query as (
        sql: string,
        params?: unknown[],
      ) => Promise<unknown>;
      let triggered = false;
      const query = (async (sql: string, params?: unknown[]) => {
        if (!triggered && sql.includes("DELETE FROM baseline_event")) {
          triggered = true;
          throw new Error("injected fault");
        }
        return innerQuery(sql, params);
      }) as unknown as PoolClient["query"];
      return { query, end: inner.end };
    }

    const outcome = await sweepCustomer(
      customerId,
      { ingestion_days: 365, analysis_days: 1095 },
      { authPool, connectCustomer: injectingConnect },
      NOW,
    );

    expect(outcome.status).toBe("failed");
    expect(outcome.errorMessage).toBe("injected fault");

    // No rows were actually deleted — ROLLBACK restored the table.
    const { rows: deRows } = await customerPool.query<{ c: string }>(
      "SELECT COUNT(*) AS c FROM detection_events",
    );
    expect(deRows[0].c).toBe("2");
    const { rows: beRows } = await customerPool.query<{ c: string }>(
      "SELECT COUNT(*) AS c FROM baseline_event",
    );
    expect(beRows[0].c).toBe("1");

    // tick_failed audit row persisted with the partial counts up to
    // the failure point (detection_events = 2 had run, baseline_event
    // = 0 because the DELETE threw before assigning).
    const { rows: auditRows } = await auditPool.query<{
      action: string;
      details: {
        partial_deleted_by_table?: Record<string, number>;
        error_message?: string;
      };
    }>(
      `SELECT action, details FROM audit_logs
        WHERE target_id = $1
        ORDER BY id`,
      [customerId],
    );
    expect(auditRows.map((r) => r.action)).toEqual([
      "retention_sweep.tick_started",
      "retention_sweep.tick_failed",
    ]);
    const failed = auditRows[1];
    expect(failed.details.error_message).toBe("injected fault");
    expect(failed.details.partial_deleted_by_table?.detection_events).toBe(2);
    expect(failed.details.partial_deleted_by_table?.baseline_event).toBe(0);
  });

  it("emits tick_failed for a connect failure with no transaction state", async () => {
    const customerId = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
    await seedPolicy(customerId, "connect-fail", 365, 1095);

    await runRetentionTick({
      authPool,
      connectCustomer: async () => {
        throw new Error("customer DB unreachable");
      },
      now: () => NOW,
    });

    const { rows } = await auditPool.query<{
      action: string;
      details: { error_message?: string };
    }>(
      `SELECT action, details FROM audit_logs
        WHERE target_id = $1
        ORDER BY id`,
      [customerId],
    );
    expect(rows.map((r) => r.action)).toEqual(["retention_sweep.tick_failed"]);
    expect(rows[0].details.error_message).toBe("customer DB unreachable");
  });

  it("advisory lock: a second concurrent sweep skips when the first holds the lock", async () => {
    const customerId = "cccccccc-cccc-cccc-cccc-cccccccccccc";
    await seedPolicy(customerId, "lock-race", 365, 1095);

    // First sweeper acquires the lock and pauses inside the
    // transaction by holding its own client open.
    const firstClient = await customerPool.connect();
    await firstClient.query("BEGIN");
    const lockResult = await firstClient.query<{ locked: boolean }>(
      `SELECT pg_try_advisory_xact_lock(
         hashtextextended(format('retention_sweep|%s', $1::text), 0)
       ) AS locked`,
      [customerId],
    );
    expect(lockResult.rows[0].locked).toBe(true);

    // Second sweep attempts the same lock and must observe locked=false.
    const secondOutcome = await sweepCustomer(
      customerId,
      { ingestion_days: 365, analysis_days: 1095 },
      { authPool, connectCustomer: customerConnect },
      NOW,
    );
    expect(secondOutcome.status).toBe("skipped_lock");

    // The skipped tick must not have emitted a tick_started row.
    const { rows: auditRows } = await auditPool.query<{ action: string }>(
      `SELECT action FROM audit_logs WHERE target_id = $1`,
      [customerId],
    );
    expect(auditRows).toEqual([]);

    await firstClient.query("ROLLBACK");
    firstClient.release();
  });

  it("refreshes requested_at via re-analysis keeps the row through the sweeper", async () => {
    const customerId = "dddddddd-dddd-dddd-dddd-dddddddddddd";
    await seedPolicy(customerId, "force-refresh", 365, 365);

    // Insert an old row that would normally be deleted at the 365-day cutoff.
    await customerPool.query(
      `INSERT INTO event_analysis_result
         (aice_id, event_key, lang, model_name, model,
          threat_score, analysis_text, redaction_policy_version,
          requested_by, requested_at)
       VALUES ('aice-r', 1, 'EN', 'openai', 'gpt-4o', 0, '', 'p',
               '00000000-0000-0000-0000-000000000000'::uuid, $1)`,
      [daysAgo(400)],
    );
    // Simulate the force=true re-analysis path (#254): requested_at is
    // refreshed to NOW. The sweeper must read the new value and keep
    // the row.
    await customerPool.query(
      `UPDATE event_analysis_result
          SET requested_at = $1
        WHERE aice_id = 'aice-r' AND event_key = 1`,
      [daysAgo(5)],
    );

    const outcome = await sweepCustomer(
      customerId,
      { ingestion_days: 365, analysis_days: 365 },
      { authPool, connectCustomer: customerConnect },
      NOW,
    );

    expect(outcome.status).toBe("completed");
    expect(outcome.counts.event_analysis_result).toBe(0);
    const { rows } = await customerPool.query<{ c: string }>(
      "SELECT COUNT(*) AS c FROM event_analysis_result",
    );
    expect(rows[0].c).toBe("1");
  });
});
