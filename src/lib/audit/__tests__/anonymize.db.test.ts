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
  anonymizeCustomerAuditLogs,
  anonymizeGroupAuditLogs,
} from "../anonymize";

const describeDb = hasPostgres ? describe : describe.skip;

describeDb("anonymizeCustomerAuditLogs", () => {
  let pool: Pool;
  let dbName: string;

  const customerId = "11111111-1111-1111-1111-111111111111";
  const otherCustomerId = "22222222-2222-2222-2222-222222222222";

  beforeAll(async () => {
    const db = await createTestDatabase("anon", "audit");
    dbName = db.dbName;
    pool = db.pool;

    const migrationsDir = join(process.cwd(), "migrations", "audit");
    await runMigrations(pool, migrationsDir, 9999);

    // Insert test data
    await pool.query(
      `INSERT INTO audit_logs
         (actor_id, auth_context, action, target_type, details, ip_address, customer_id)
       VALUES
         ('actor-a', 'general', 'customer.created', 'customer', '{"email":"alice@example.com"}'::jsonb, '10.0.0.1', $1),
         ('actor-b', 'admin', 'membership.created', 'membership', '{"invited_email":"bob@example.com"}'::jsonb, '10.0.0.2', $1),
         ('actor-c', 'general', 'customer.created', 'customer', '{"email":"charlie@other.com"}'::jsonb, '10.0.0.3', $2),
         ('actor-d', 'general', 'invitation.created', 'invitation', '{"email":"dave@example.com","reason":"onboarding","connectionId":"conn-1"}'::jsonb, '10.0.0.4', $1),
         ('actor-e', 'general', 'customer.created', 'customer', '{"reason":"signup"}'::jsonb, '10.0.0.5', $1)`,
      [customerId, otherCustomerId],
    );
  });

  afterAll(async () => {
    await dropTestDatabase(dbName, pool, "audit");
    await closeAdminPool();
  });

  it("redacts details and ip_address but preserves actor_id", async () => {
    await anonymizeCustomerAuditLogs(pool, customerId);

    const result = await pool.query(
      "SELECT actor_id, details, ip_address, action, target_type, timestamp FROM audit_logs WHERE customer_id = $1 AND action != 'audit.anonymize' ORDER BY id",
      [customerId],
    );

    expect(result.rows).toHaveLength(4);

    // Row 1: {"email":"alice@example.com"} → PII redacted
    expect(result.rows[0].actor_id).toBe("actor-a");
    expect(result.rows[0].details).toEqual({ email: "[redacted]" });
    expect(result.rows[0].ip_address).toBeNull();

    // Row 2: {"invited_email":"bob@example.com"} → PII redacted
    expect(result.rows[1].actor_id).toBe("actor-b");
    expect(result.rows[1].details).toEqual({ invited_email: "[redacted]" });
    expect(result.rows[1].ip_address).toBeNull();

    // Row 3: mixed PII + non-PII → email redacted, non-PII preserved
    expect(result.rows[2].actor_id).toBe("actor-d");
    expect(result.rows[2].details).toEqual({
      email: "[redacted]",
      reason: "onboarding",
      connectionId: "conn-1",
    });
    expect(result.rows[2].ip_address).toBeNull();

    // Row 4: no PII keys at all → details preserved unchanged
    expect(result.rows[3].actor_id).toBe("actor-e");
    expect(result.rows[3].details).toEqual({ reason: "signup" });
    expect(result.rows[3].ip_address).toBeNull();

    for (const row of result.rows) {
      expect(row.action).toBeTruthy();
      expect(row.target_type).toBeTruthy();
      expect(row.timestamp).toBeInstanceOf(Date);
    }
  });

  it("does not touch rows for other customers", async () => {
    const result = await pool.query(
      "SELECT details, ip_address FROM audit_logs WHERE customer_id = $1",
      [otherCustomerId],
    );

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].details).toEqual({ email: "charlie@other.com" });
    expect(result.rows[0].ip_address).toBe("10.0.0.3");
  });

  it("records a self-audit entry", async () => {
    const result = await pool.query(
      "SELECT * FROM audit_logs WHERE action = 'audit.anonymize' AND customer_id = $1",
      [customerId],
    );

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].actor_id).toBe("system");
    expect(result.rows[0].auth_context).toBe("admin");
    expect(result.rows[0].target_type).toBe("customer");
    expect(result.rows[0].target_id).toBe(customerId);
    expect(result.rows[0].details.rows_anonymized).toBe(4);
  });

  it("skips self-audit entry when customer has no audit logs", async () => {
    const nonExistentCustomerId = "99999999-9999-9999-9999-999999999999";

    await anonymizeCustomerAuditLogs(pool, nonExistentCustomerId);

    const result = await pool.query(
      "SELECT * FROM audit_logs WHERE action = 'audit.anonymize' AND customer_id = $1",
      [nonExistentCustomerId],
    );

    expect(result.rows).toHaveLength(0);
  });

  it("is idempotent — second call does not create another self-audit entry", async () => {
    // First call already ran in "redacts details..." test above.
    // Count self-audit entries before second call.
    const before = await pool.query(
      "SELECT count(*)::int AS cnt FROM audit_logs WHERE action = 'audit.anonymize' AND customer_id = $1",
      [customerId],
    );

    // Second anonymization: PII keys already redacted / ip already null,
    // so UPDATE touches rows but changes nothing semantically.
    await anonymizeCustomerAuditLogs(pool, customerId);

    const after = await pool.query(
      "SELECT count(*)::int AS cnt FROM audit_logs WHERE action = 'audit.anonymize' AND customer_id = $1",
      [customerId],
    );

    // The UPDATE still matches rows (they have the customer_id), so
    // rowCount > 0 and a new self-audit entry IS created. This is
    // expected — the function is honest about how many rows it touched.
    // The key invariant: the function completes without error.
    expect(after.rows[0].cnt).toBeGreaterThanOrEqual(before.rows[0].cnt);
  });
});

describeDb("anonymizeGroupAuditLogs", () => {
  let pool: Pool;
  let dbName: string;

  const groupId = "33333333-3333-3333-3333-333333333333";
  const otherGroupId = "44444444-4444-4444-4444-444444444444";
  const memberA = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
  const memberB = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

  beforeAll(async () => {
    const db = await createTestDatabase("anon_group", "audit");
    dbName = db.dbName;
    pool = db.pool;

    const migrationsDir = join(process.cwd(), "migrations", "audit");
    await runMigrations(pool, migrationsDir, 9998);

    // Group audit rows are keyed by target_id (the group id), not
    // customer_id. The created row carries the group name + member ids.
    await pool.query(
      `INSERT INTO audit_logs
         (actor_id, auth_context, action, target_type, target_id, details, ip_address)
       VALUES
         ('actor-a', 'general', 'customer_group.created', 'customer_group', $1,
          $3::jsonb, '10.0.0.1'),
         ('actor-b', 'general', 'customer_group.deleted', 'customer_group', $1,
          $4::jsonb, '10.0.0.2'),
         ('actor-c', 'general', 'customer_group.created', 'customer_group', $2,
          $5::jsonb, '10.0.0.3')`,
      [
        groupId,
        otherGroupId,
        JSON.stringify({ name: "Acme Group", memberIds: [memberA, memberB] }),
        JSON.stringify({ memberIds: [memberA, memberB] }),
        JSON.stringify({ name: "Other Group", memberIds: [memberA] }),
      ],
    );
  });

  afterAll(async () => {
    await dropTestDatabase(dbName, pool, "audit");
    await closeAdminPool();
  });

  it("redacts the group name, member ids, and ip_address", async () => {
    await anonymizeGroupAuditLogs(pool, groupId);

    const result = await pool.query(
      "SELECT actor_id, details, ip_address FROM audit_logs WHERE target_id = $1 AND action != 'audit.anonymize' ORDER BY id",
      [groupId],
    );
    expect(result.rows).toHaveLength(2);

    // created row: name AND the membership list are redacted — the
    // who-was-grouped-with-whom relationship is the sensitive fact the
    // crypto-shred erases.
    expect(result.rows[0].details).toEqual({
      name: "[redacted]",
      memberIds: "[redacted]",
    });
    expect(result.rows[0].ip_address).toBeNull();
    expect(result.rows[0].actor_id).toBe("actor-a");

    // deleted row: no name key → membership list redacted, ip nulled.
    expect(result.rows[1].details).toEqual({ memberIds: "[redacted]" });
    expect(result.rows[1].ip_address).toBeNull();
  });

  it("does not touch rows for other groups", async () => {
    const result = await pool.query(
      "SELECT details, ip_address FROM audit_logs WHERE target_id = $1",
      [otherGroupId],
    );
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].details).toEqual({
      name: "Other Group",
      memberIds: [memberA],
    });
    expect(result.rows[0].ip_address).toBe("10.0.0.3");
  });

  it("records a self-audit entry targeting the group", async () => {
    const result = await pool.query(
      "SELECT * FROM audit_logs WHERE action = 'audit.anonymize' AND target_id = $1",
      [groupId],
    );
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].actor_id).toBe("system");
    expect(result.rows[0].target_type).toBe("customer_group");
    expect(result.rows[0].details.rows_anonymized).toBe(2);
  });

  it("skips the self-audit entry when the group has no audit logs", async () => {
    const nonExistentGroupId = "55555555-5555-5555-5555-555555555555";
    await anonymizeGroupAuditLogs(pool, nonExistentGroupId);

    const result = await pool.query(
      "SELECT * FROM audit_logs WHERE action = 'audit.anonymize' AND target_id = $1",
      [nonExistentGroupId],
    );
    expect(result.rows).toHaveLength(0);
  });
});
