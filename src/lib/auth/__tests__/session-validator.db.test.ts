import { join } from "node:path";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  closeAdminPool,
  createTestDatabase,
  dropTestDatabase,
  hasPostgres,
} from "../../db/__tests__/db-test-helpers";
import { runMigrations } from "../../db/migrate";
import {
  SessionExpiredError,
  SessionRevokedError,
  validateSession,
} from "../session-validator";

const MIGRATIONS_DIR = join(process.cwd(), "migrations", "auth");
const LOCK_ID = 1030;

describe.skipIf(!hasPostgres)("validateSession (DB integration)", () => {
  let pool: Pool;
  let dbName: string;
  let accountId: string;

  const defaultPolicy = {
    idle_timeout_minutes: 30,
    absolute_timeout_minutes: 480,
  };

  beforeAll(async () => {
    const result = await createTestDatabase("sessval", "auth");
    pool = result.pool;
    dbName = result.dbName;

    await pool.query(`
        DO $$ BEGIN
          IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'aimer_auth') THEN
            CREATE ROLE aimer_auth LOGIN PASSWORD 'changeme';
          END IF;
        END $$
      `);

    await runMigrations(pool, MIGRATIONS_DIR, LOCK_ID);

    const acct = await pool.query<{ id: string }>(
      `INSERT INTO accounts (oidc_issuer, oidc_subject, username, display_name)
         VALUES ('test-issuer', 'sv-001', 'svuser', 'Session Validator User')
         RETURNING id`,
    );
    accountId = acct.rows[0].id;
  });

  afterAll(async () => {
    await dropTestDatabase(dbName, pool, "auth");
    await closeAdminPool();
  });

  it("returns session data for a valid session", async () => {
    const sess = await pool.query<{ sid: string }>(
      `INSERT INTO sessions (account_id, auth_context, ip_address, user_agent)
         VALUES ($1, 'general', '127.0.0.1', 'test') RETURNING sid`,
      [accountId],
    );

    const result = await validateSession(pool, sess.rows[0].sid, defaultPolicy);
    expect(result.bridgeAiceId).toBeNull();
    expect(result.bridgeCustomerIds).toBeNull();
    expect(result.createdAt).toBeGreaterThan(0);
  });

  it("returns bridge fields when present", async () => {
    const custId = (
      await pool.query<{ id: string }>(
        `INSERT INTO customers (external_key, name) VALUES ('sv-cust', 'SV Customer') RETURNING id`,
      )
    ).rows[0].id;

    await pool.query(
      `INSERT INTO aice_environments (aice_id, name) VALUES ('sv-aice.example.com', 'SV Env') ON CONFLICT DO NOTHING`,
    );

    const sess = await pool.query<{ sid: string }>(
      `INSERT INTO sessions (account_id, auth_context, ip_address, user_agent, bridge_aice_id, bridge_customer_ids)
         VALUES ($1, 'general', '127.0.0.1', 'test', 'sv-aice.example.com', $2) RETURNING sid`,
      [accountId, [custId]],
    );

    const result = await validateSession(pool, sess.rows[0].sid, defaultPolicy);
    expect(result.bridgeAiceId).toBe("sv-aice.example.com");
    expect(result.bridgeCustomerIds).toContain(custId);
  });

  it("throws SessionRevokedError for revoked session", async () => {
    const sess = await pool.query<{ sid: string }>(
      `INSERT INTO sessions (account_id, auth_context, ip_address, user_agent, revoked)
         VALUES ($1, 'general', '127.0.0.1', 'test', true) RETURNING sid`,
      [accountId],
    );

    await expect(
      validateSession(pool, sess.rows[0].sid, defaultPolicy),
    ).rejects.toThrow(SessionRevokedError);
  });

  it("throws SessionExpiredError(idle) for idle session", async () => {
    const sess = await pool.query<{ sid: string }>(
      `INSERT INTO sessions (account_id, auth_context, ip_address, user_agent, last_active_at)
         VALUES ($1, 'general', '127.0.0.1', 'test', NOW() - INTERVAL '31 minutes') RETURNING sid`,
      [accountId],
    );

    await expect(
      validateSession(pool, sess.rows[0].sid, defaultPolicy),
    ).rejects.toThrow(SessionExpiredError);

    try {
      await validateSession(pool, sess.rows[0].sid, defaultPolicy);
    } catch (err) {
      expect((err as SessionExpiredError).reason).toBe("idle");
    }
  });

  it("throws SessionExpiredError(absolute) for session past absolute timeout", async () => {
    const sess = await pool.query<{ sid: string }>(
      `INSERT INTO sessions (account_id, auth_context, ip_address, user_agent, created_at, last_active_at)
         VALUES ($1, 'general', '127.0.0.1', 'test', NOW() - INTERVAL '9 hours', NOW()) RETURNING sid`,
      [accountId],
    );

    await expect(
      validateSession(pool, sess.rows[0].sid, defaultPolicy),
    ).rejects.toThrow(SessionExpiredError);

    try {
      await validateSession(pool, sess.rows[0].sid, defaultPolicy);
    } catch (err) {
      expect((err as SessionExpiredError).reason).toBe("absolute");
    }
  });

  it("throws SessionExpiredError for non-existent session", async () => {
    await expect(
      validateSession(
        pool,
        "00000000-0000-0000-0000-000000000000",
        defaultPolicy,
      ),
    ).rejects.toThrow(SessionExpiredError);
  });

  it("updates last_active_at on successful validation", async () => {
    const sess = await pool.query<{ sid: string }>(
      `INSERT INTO sessions (account_id, auth_context, ip_address, user_agent, last_active_at)
         VALUES ($1, 'general', '127.0.0.1', 'test', NOW() - INTERVAL '5 minutes') RETURNING sid`,
      [accountId],
    );
    const sid = sess.rows[0].sid;

    const before = await pool.query<{ last_active_at: Date }>(
      `SELECT last_active_at FROM sessions WHERE sid = $1`,
      [sid],
    );

    await validateSession(pool, sid, defaultPolicy);

    const after = await pool.query<{ last_active_at: Date }>(
      `SELECT last_active_at FROM sessions WHERE sid = $1`,
      [sid],
    );

    expect(after.rows[0].last_active_at.getTime()).toBeGreaterThan(
      before.rows[0].last_active_at.getTime(),
    );
  });
});
