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
import {
  closeAdminPool,
  createTestDatabase,
  dropTestDatabase,
  hasPostgres,
} from "../../db/__tests__/db-test-helpers";
import { runMigrations } from "../../db/migrate";

vi.mock("server-only", () => ({}));

const AUTH_MIGRATIONS_DIR = join(process.cwd(), "migrations", "auth");
const LOCK_ID = 3200;

describe.skipIf(!hasPostgres)("runPostRestoreCleanup (DB)", () => {
  let pool: Pool;
  let dbName: string;

  beforeAll(async () => {
    const result = await createTestDatabase("post_restore");
    pool = result.pool;
    dbName = result.dbName;
    await runMigrations(pool, AUTH_MIGRATIONS_DIR, LOCK_ID);
  });

  afterAll(async () => {
    await dropTestDatabase(dbName, pool);
    await closeAdminPool();
  });

  beforeEach(async () => {
    // Clean up from previous tests
    await pool.query("DELETE FROM staged_event_customers");
    await pool.query("DELETE FROM staged_event_payloads");
    await pool.query("DELETE FROM pending_connections");
    await pool.query("DELETE FROM sessions");
    await pool.query("DELETE FROM account_customer_memberships");
    await pool.query("DELETE FROM accounts");
    await pool.query("DELETE FROM customers");
  });

  async function seedData() {
    // Create an account (needed for sessions FK)
    const account = await pool.query(
      `INSERT INTO accounts (oidc_issuer, oidc_subject, username, display_name)
       VALUES ('https://keycloak/realms/test', 'user-1', 'testuser1', 'Test User')
       RETURNING id`,
    );
    const accountId = account.rows[0].id;

    // Create sessions (one active, one already revoked)
    await pool.query(
      `INSERT INTO sessions (account_id, ip_address, user_agent, revoked)
       VALUES ($1, '127.0.0.1', 'test-agent', false),
              ($1, '127.0.0.1', 'test-agent', true)`,
      [accountId],
    );

    // Create a pending connection
    await pool.query(
      `INSERT INTO pending_connections (jti, issuer, aice_id, customer_ids, expires_at)
       VALUES ('jti-1', 'https://aice', 'aice-1', '{}', NOW() + INTERVAL '1 hour')`,
    );

    // Create a customer for staged events
    const customer = await pool.query(
      `INSERT INTO customers (external_key, name) VALUES ('ext-1', 'Cust 1')
       RETURNING id`,
    );
    const customerId = customer.rows[0].id;

    // Get one of the sessions
    const session = await pool.query("SELECT sid FROM sessions LIMIT 1");
    const sessionId = session.rows[0].sid;

    // Create a pending connection for the payload
    const conn = await pool.query(
      `INSERT INTO pending_connections (jti, issuer, aice_id, customer_ids, expires_at)
       VALUES ('jti-payload', 'https://aice', 'aice-1', '{}', NOW() + INTERVAL '1 hour')
       RETURNING connection_id`,
    );
    const connectionId = conn.rows[0].connection_id;

    // Create staged event payload
    const payload = await pool.query(
      `INSERT INTO staged_event_payloads
         (connection_id, session_id, aice_id, payload_hash, payload,
          event_count, schema_version, wrapped_dek, expires_at)
       VALUES ($1, $2, 'aice-1', 'hash1', '\\x00',
               1, '1.0', 'vault:v1:fake-wrapped-dek', NOW() + INTERVAL '1 hour')
       RETURNING id`,
      [connectionId, sessionId],
    );
    const payloadId = payload.rows[0].id;

    // Create staged event customer
    await pool.query(
      `INSERT INTO staged_event_customers (payload_id, customer_id)
       VALUES ($1, $2)`,
      [payloadId, customerId],
    );

    return { accountId, customerId };
  }

  it("revokes active sessions and clears ephemeral tables", async () => {
    await seedData();

    // Verify seed data
    const before = {
      activeSessions: await pool
        .query("SELECT count(*) FROM sessions WHERE revoked = false")
        .then((r) => Number(r.rows[0].count)),
      pendingConnections: await pool
        .query("SELECT count(*) FROM pending_connections")
        .then((r) => Number(r.rows[0].count)),
      stagedCustomers: await pool
        .query("SELECT count(*) FROM staged_event_customers")
        .then((r) => Number(r.rows[0].count)),
      stagedPayloads: await pool
        .query("SELECT count(*) FROM staged_event_payloads")
        .then((r) => Number(r.rows[0].count)),
    };

    expect(before.activeSessions).toBe(1);
    expect(before.pendingConnections).toBe(2);
    expect(before.stagedCustomers).toBe(1);
    expect(before.stagedPayloads).toBe(1);

    // Run cleanup
    const { runPostRestoreCleanup } = await import("../post-restore");
    const result = await runPostRestoreCleanup(pool);

    expect(result.sessionsRevoked).toBe(1);
    expect(result.pendingConnectionsDeleted).toBe(2);
    expect(result.stagedCustomersDeleted).toBe(1);
    expect(result.stagedPayloadsDeleted).toBe(1);

    // Verify all sessions are revoked
    const after = await pool.query(
      "SELECT count(*) FROM sessions WHERE revoked = false",
    );
    expect(Number(after.rows[0].count)).toBe(0);

    // Verify ephemeral tables are empty
    for (const table of [
      "pending_connections",
      "staged_event_customers",
      "staged_event_payloads",
    ]) {
      const result = await pool.query(`SELECT count(*) FROM ${table}`);
      expect(Number(result.rows[0].count)).toBe(0);
    }
  });

  it("returns zeros when tables are already clean", async () => {
    const { runPostRestoreCleanup } = await import("../post-restore");
    const result = await runPostRestoreCleanup(pool);

    expect(result.sessionsRevoked).toBe(0);
    expect(result.pendingConnectionsDeleted).toBe(0);
    expect(result.stagedCustomersDeleted).toBe(0);
    expect(result.stagedPayloadsDeleted).toBe(0);
  });
});
