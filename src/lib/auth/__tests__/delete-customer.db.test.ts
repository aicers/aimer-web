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

// Mock Transit
const mockDeleteTransitKey = vi.fn().mockResolvedValue(undefined);
vi.mock("../../crypto/transit", () => ({
  getTransitConfig: () => ({ addr: "http://mock:8200", token: "mock" }),
  generateDataKey: vi.fn().mockResolvedValue({
    plaintext: Buffer.alloc(32, 0xab),
    wrappedDek: "vault:v1:mock-wrapped-dek",
  }),
  deleteTransitKey: (...args: unknown[]) => mockDeleteTransitKey(...args),
}));

const AUTH_MIGRATIONS_DIR = join(process.cwd(), "migrations", "auth");
const AUDIT_MIGRATIONS_DIR = join(process.cwd(), "migrations", "audit");
const LOCK_ID = 3100;

describe.skipIf(!hasPostgres)("deleteCustomer (DB integration)", () => {
  let authPool: Pool;
  let auditPool: Pool;
  let authDbName: string;
  let authDbUrl: string;
  let auditDbName: string;
  let managerAccountId: string;
  let analystAccountId: string;

  beforeAll(async () => {
    const authResult = await createTestDatabase("delete_cust", "auth");
    authPool = authResult.pool;
    authDbName = authResult.dbName;
    authDbUrl = authResult.url;

    const auditResult = await createTestDatabase("delete_cust_audit", "audit");
    auditPool = auditResult.pool;
    auditDbName = auditResult.dbName;

    // Ensure roles exist
    for (const role of [
      "aimer_auth",
      "aimer_audit_owner",
      "aimer_audit",
      "aimer_customer_owner",
      "aimer_customer",
    ]) {
      await authPool.query(`
        DO $$ BEGIN
          IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${role}') THEN
            CREATE ROLE ${role} LOGIN PASSWORD 'changeme';
          END IF;
        END $$
      `);
    }

    await runMigrations(authPool, AUTH_MIGRATIONS_DIR, LOCK_ID);
    await runMigrations(auditPool, AUDIT_MIGRATIONS_DIR, LOCK_ID + 1);

    // Create test accounts
    const mgr = await authPool.query<{ id: string }>(
      `INSERT INTO accounts (oidc_issuer, oidc_subject, username, display_name, email)
       VALUES ('test-issuer', 'mgr-del', 'manager-del', 'Manager', 'mgr-del@example.com')
       RETURNING id`,
    );
    managerAccountId = mgr.rows[0].id;

    const analyst = await authPool.query<{ id: string }>(
      `INSERT INTO accounts (oidc_issuer, oidc_subject, username, display_name, email)
       VALUES ('test-issuer', 'analyst-del', 'analyst-del', 'Analyst', 'analyst-del@example.com')
       RETURNING id`,
    );
    analystAccountId = analyst.rows[0].id;
  });

  afterAll(async () => {
    await dropTestDatabase(authDbName, authPool, "auth");
    await dropTestDatabase(auditDbName, auditPool, "audit");
    await closeAdminPool();
  });

  beforeEach(() => {
    mockDeleteTransitKey.mockClear();
  });

  async function createTestCustomer(externalKey: string): Promise<string> {
    const { createCustomer } = await import("../customers");
    const client = await authPool.connect();
    try {
      await client.query("BEGIN");
      const customer = await createCustomer(client, {
        name: `Test ${externalKey}`,
        externalKey,
        managerAccountId,
      });
      await client.query("COMMIT");
      return customer.id;
    } finally {
      client.release();
    }
  }

  // =====================================================================
  // Basic deletion with CASCADE verification
  // =====================================================================

  it("deletes customer and cascades memberships, assignments", async () => {
    const customerId = await createTestCustomer("del-cascade");

    // Add analyst assignment
    await authPool.query(
      `INSERT INTO analyst_customer_assignments (account_id, customer_id, assigned_by)
       VALUES ($1, $2, $3)`,
      [analystAccountId, customerId, managerAccountId],
    );

    // Verify data exists before delete
    const membersBefore = await authPool.query(
      "SELECT 1 FROM account_customer_memberships WHERE customer_id = $1",
      [customerId],
    );
    expect(membersBefore.rows.length).toBe(1);

    const assignmentsBefore = await authPool.query(
      "SELECT 1 FROM analyst_customer_assignments WHERE customer_id = $1",
      [customerId],
    );
    expect(assignmentsBefore.rows.length).toBe(1);

    // Delete
    const { deleteCustomer } = await import("../delete-customer");
    await deleteCustomer(authPool, auditPool, customerId, undefined, {
      adminUrl: authDbUrl,
      skipTransit: true,
      skipAuditAnonymize: true,
    });

    // Verify customer is gone
    const customerAfter = await authPool.query(
      "SELECT 1 FROM customers WHERE id = $1",
      [customerId],
    );
    expect(customerAfter.rows.length).toBe(0);

    // Verify cascaded data is gone
    const membersAfter = await authPool.query(
      "SELECT 1 FROM account_customer_memberships WHERE customer_id = $1",
      [customerId],
    );
    expect(membersAfter.rows.length).toBe(0);

    const assignmentsAfter = await authPool.query(
      "SELECT 1 FROM analyst_customer_assignments WHERE customer_id = $1",
      [customerId],
    );
    expect(assignmentsAfter.rows.length).toBe(0);
  });

  // =====================================================================
  // staged_event_customers cleanup (no CASCADE)
  // =====================================================================

  it("deletes staged_event_customers and orphaned payloads", async () => {
    const customerId = await createTestCustomer("del-staged");

    // Create a session and staged event referencing this customer
    const session = await authPool.query<{ sid: string }>(
      `INSERT INTO sessions (account_id, auth_context, ip_address, user_agent)
       VALUES ($1, 'general', '127.0.0.1', 'test')
       RETURNING sid`,
      [managerAccountId],
    );
    const sessionId = session.rows[0].sid;

    const payload = await authPool.query<{ id: string }>(
      `INSERT INTO staged_event_payloads
         (session_id, aice_id, payload_hash, payload, wrapped_dek, event_count, schema_version, expires_at)
       VALUES ($1, 'aice-1', 'hash-del', '\\x00', 'wrapped', 1, '1.0', NOW() + INTERVAL '1 hour')
       RETURNING id`,
      [sessionId],
    );
    const payloadId = payload.rows[0].id;

    await authPool.query(
      `INSERT INTO staged_event_customers (payload_id, customer_id, status)
       VALUES ($1, $2, 'pending')`,
      [payloadId, customerId],
    );

    const { deleteCustomer } = await import("../delete-customer");
    await deleteCustomer(authPool, auditPool, customerId, undefined, {
      adminUrl: authDbUrl,
      skipTransit: true,
      skipAuditAnonymize: true,
    });

    // Staged event customer row is gone
    const secAfter = await authPool.query(
      "SELECT 1 FROM staged_event_customers WHERE customer_id = $1",
      [customerId],
    );
    expect(secAfter.rows.length).toBe(0);

    // Orphaned payload is also cleaned up
    const payloadAfter = await authPool.query(
      "SELECT 1 FROM staged_event_payloads WHERE id = $1",
      [payloadId],
    );
    expect(payloadAfter.rows.length).toBe(0);
  });

  it("does not delete payloads with remaining customers", async () => {
    const customerA = await createTestCustomer("del-staged-keep-a");
    const customerB = await createTestCustomer("del-staged-keep-b");

    const session = await authPool.query<{ sid: string }>(
      `INSERT INTO sessions (account_id, auth_context, ip_address, user_agent)
       VALUES ($1, 'general', '127.0.0.1', 'test')
       RETURNING sid`,
      [managerAccountId],
    );
    const sessionId = session.rows[0].sid;

    const payload = await authPool.query<{ id: string }>(
      `INSERT INTO staged_event_payloads
         (session_id, aice_id, payload_hash, payload, wrapped_dek, event_count, schema_version, expires_at)
       VALUES ($1, 'aice-1', 'hash-keep', '\\x00', 'wrapped', 1, '1.0', NOW() + INTERVAL '1 hour')
       RETURNING id`,
      [sessionId],
    );
    const payloadId = payload.rows[0].id;

    // Both customers linked to same payload
    await authPool.query(
      `INSERT INTO staged_event_customers (payload_id, customer_id, status)
       VALUES ($1, $2, 'pending'), ($1, $3, 'pending')`,
      [payloadId, customerA, customerB],
    );

    // Delete only customer A
    const { deleteCustomer } = await import("../delete-customer");
    await deleteCustomer(authPool, auditPool, customerA, undefined, {
      adminUrl: authDbUrl,
      skipTransit: true,
      skipAuditAnonymize: true,
    });

    // Payload should still exist (customer B is still pending)
    const payloadAfter = await authPool.query(
      "SELECT 1 FROM staged_event_payloads WHERE id = $1",
      [payloadId],
    );
    expect(payloadAfter.rows.length).toBe(1);

    // Customer B's staged event row should still exist
    const secB = await authPool.query(
      "SELECT 1 FROM staged_event_customers WHERE payload_id = $1 AND customer_id = $2",
      [payloadId, customerB],
    );
    expect(secB.rows.length).toBe(1);

    // Clean up
    await deleteCustomer(authPool, auditPool, customerB, undefined, {
      adminUrl: authDbUrl,
      skipTransit: true,
      skipAuditAnonymize: true,
    });
  });

  it("cleans up payloads where remaining customers are all terminal", async () => {
    const customerA = await createTestCustomer("del-terminal-a");
    const customerB = await createTestCustomer("del-terminal-b");

    const session = await authPool.query<{ sid: string }>(
      `INSERT INTO sessions (account_id, auth_context, ip_address, user_agent)
       VALUES ($1, 'general', '127.0.0.1', 'test')
       RETURNING sid`,
      [managerAccountId],
    );
    const sessionId = session.rows[0].sid;

    const payload = await authPool.query<{ id: string }>(
      `INSERT INTO staged_event_payloads
         (session_id, aice_id, payload_hash, payload, wrapped_dek, event_count, schema_version, expires_at)
       VALUES ($1, 'aice-1', 'hash-term', '\\x00', 'wrapped', 1, '1.0', NOW() + INTERVAL '1 hour')
       RETURNING id`,
      [sessionId],
    );
    const payloadId = payload.rows[0].id;

    // Customer A is pending, Customer B is already approved (terminal)
    await authPool.query(
      `INSERT INTO staged_event_customers (payload_id, customer_id, status)
       VALUES ($1, $2, 'pending'), ($1, $3, 'approved')`,
      [payloadId, customerA, customerB],
    );

    // Delete customer A — now only customer B (approved/terminal) remains
    const { deleteCustomer } = await import("../delete-customer");
    await deleteCustomer(authPool, auditPool, customerA, undefined, {
      adminUrl: authDbUrl,
      skipTransit: true,
      skipAuditAnonymize: true,
    });

    // Payload should be cleaned up because only terminal rows remain
    const payloadAfter = await authPool.query(
      "SELECT 1 FROM staged_event_payloads WHERE id = $1",
      [payloadId],
    );
    expect(payloadAfter.rows.length).toBe(0);

    // Clean up customer B
    await deleteCustomer(authPool, auditPool, customerB, undefined, {
      adminUrl: authDbUrl,
      skipTransit: true,
      skipAuditAnonymize: true,
    });
  });

  // =====================================================================
  // 44-4: Hard delete → DB dropped + DEK destroyed
  // =====================================================================

  it("drops customer database during deletion", async () => {
    const customerId = await createTestCustomer("del-drop-db");

    // Create the customer database
    const dbName = `customer_${customerId.replace(/-/g, "")}`;
    await authPool.query(`CREATE DATABASE ${dbName}`);

    // Verify it exists
    const before = await authPool.query(
      "SELECT 1 FROM pg_database WHERE datname = $1",
      [dbName],
    );
    expect(before.rows.length).toBe(1);

    const { deleteCustomer } = await import("../delete-customer");
    await deleteCustomer(authPool, auditPool, customerId, undefined, {
      adminUrl: authDbUrl,
      skipTransit: true,
      skipAuditAnonymize: true,
    });

    // Verify database was dropped
    const after = await authPool.query(
      "SELECT 1 FROM pg_database WHERE datname = $1",
      [dbName],
    );
    expect(after.rows.length).toBe(0);
  });

  // =====================================================================
  // 44-5: Hard delete → audit log anonymized
  // =====================================================================

  it("anonymizes audit log entries for deleted customer", async () => {
    const customerId = await createTestCustomer("del-audit-anon");

    // Insert audit logs for this customer
    await auditPool.query(
      `INSERT INTO audit_logs (actor_id, action, target_type, target_id, customer_id, details, ip_address)
       VALUES ($1, 'test.action', 'customer', $2, $3, '{"key":"value"}'::jsonb, '192.168.1.1')`,
      [managerAccountId, customerId, customerId],
    );

    // Verify audit log exists with data
    const before = await auditPool.query(
      "SELECT actor_id, details, ip_address FROM audit_logs WHERE customer_id = $1",
      [customerId],
    );
    expect(before.rows.length).toBe(1);
    expect(before.rows[0].actor_id).toBe(managerAccountId);
    expect(before.rows[0].ip_address).toBe("192.168.1.1");

    const { deleteCustomer } = await import("../delete-customer");
    await deleteCustomer(authPool, auditPool, customerId, undefined, {
      adminUrl: authDbUrl,
      skipTransit: true,
    });

    // Verify audit log was anonymized
    const after = await auditPool.query(
      "SELECT actor_id, details, ip_address FROM audit_logs WHERE customer_id = $1 AND action = 'test.action'",
      [customerId],
    );
    expect(after.rows.length).toBe(1);
    expect(after.rows[0].actor_id).toBe(managerAccountId);
    // {"key":"value"} has no PII keys, so details are preserved as-is
    expect(after.rows[0].details).toEqual({ key: "value" });
    expect(after.rows[0].ip_address).toBeNull();

    // Verify self-audit row was created
    const selfAudit = await auditPool.query(
      "SELECT action, target_type, target_id, details FROM audit_logs WHERE customer_id = $1 AND action = 'audit.anonymize'",
      [customerId],
    );
    expect(selfAudit.rows.length).toBe(1);
    expect(selfAudit.rows[0].target_type).toBe("customer");
    expect(selfAudit.rows[0].target_id).toBe(customerId);
    expect(selfAudit.rows[0].details).toEqual({ rows_anonymized: 1 });
  });

  // =====================================================================
  // Error handling
  // =====================================================================

  it("throws HttpError 404 for non-existent customer", async () => {
    const { deleteCustomer } = await import("../delete-customer");
    const { HttpError } = await import("../errors");
    try {
      await deleteCustomer(
        authPool,
        auditPool,
        "00000000-0000-0000-0000-000000000000",
        undefined,
        { adminUrl: authDbUrl, skipTransit: true, skipAuditAnonymize: true },
      );
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(HttpError);
      expect((err as InstanceType<typeof HttpError>).statusCode).toBe(404);
    }
  });

  it("cascades invitation deletion", async () => {
    const customerId = await createTestCustomer("del-invitations");

    // Create an invitation for this customer
    const { createHash } = await import("node:crypto");
    const tokenHash = createHash("sha256")
      .update("test-invite-token")
      .digest("hex");
    const roleId = await authPool
      .query<{ id: number }>(
        "SELECT id FROM roles WHERE name = 'User' AND auth_context = 'general'",
      )
      .then((r) => r.rows[0].id);

    await authPool.query(
      `INSERT INTO invitations (token_hash, customer_id, invited_email, role_id, invited_by)
       VALUES ($1, $2, 'test@example.com', $3, $4)`,
      [tokenHash, customerId, roleId, managerAccountId],
    );

    const invBefore = await authPool.query(
      "SELECT 1 FROM invitations WHERE customer_id = $1",
      [customerId],
    );
    expect(invBefore.rows.length).toBe(1);

    const { deleteCustomer } = await import("../delete-customer");
    await deleteCustomer(authPool, auditPool, customerId, undefined, {
      adminUrl: authDbUrl,
      skipTransit: true,
      skipAuditAnonymize: true,
    });

    const invAfter = await authPool.query(
      "SELECT 1 FROM invitations WHERE customer_id = $1",
      [customerId],
    );
    expect(invAfter.rows.length).toBe(0);
  });

  // =====================================================================
  // #510: deleting a member customer auto-deletes every group it belonged to
  // =====================================================================

  it("auto-deletes groups the deleted customer belonged to (#510)", async () => {
    const memberA = await createTestCustomer("del-grp-a");
    const memberB = await createTestCustomer("del-grp-b");

    const { createGroup } = await import("../../groups/groups");
    const client = await authPool.connect();
    let groupId: string;
    try {
      await client.query("BEGIN");
      const group = await createGroup(client, {
        name: "Doomed Group",
        description: null,
        memberIds: [memberA, memberB],
        tz: "UTC",
        creatorAccountId: managerAccountId,
        analysisDays: 1095,
      });
      await client.query("COMMIT");
      groupId = group.id;
    } finally {
      client.release();
    }

    // The group entity exists before the member is deleted.
    const before = await authPool.query(
      "SELECT 1 FROM customer_groups WHERE id = $1",
      [groupId],
    );
    expect(before.rows.length).toBe(1);

    // Deleting one member tears the whole group down: the membership set is
    // immutable, so a group can never lose a member and keep generating.
    const { deleteCustomer } = await import("../delete-customer");
    await deleteCustomer(authPool, auditPool, memberA, undefined, {
      adminUrl: authDbUrl,
      skipTransit: true,
      skipAuditAnonymize: true,
    });

    // The group entity (and its subject / member / retention rows) are gone.
    const groupAfter = await authPool.query(
      "SELECT 1 FROM customer_groups WHERE id = $1",
      [groupId],
    );
    expect(groupAfter.rows.length).toBe(0);
    const subjectAfter = await authPool.query(
      "SELECT 1 FROM subjects WHERE id = $1",
      [groupId],
    );
    expect(subjectAfter.rows.length).toBe(0);
    const membersAfter = await authPool.query(
      "SELECT 1 FROM customer_group_members WHERE group_id = $1",
      [groupId],
    );
    expect(membersAfter.rows.length).toBe(0);

    // Clean up the surviving member.
    await deleteCustomer(authPool, auditPool, memberB, undefined, {
      adminUrl: authDbUrl,
      skipTransit: true,
      skipAuditAnonymize: true,
    });
  });
});
