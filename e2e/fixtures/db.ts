import { randomUUID } from "node:crypto";
import { Pool } from "pg";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TestAccount {
  accountId: string;
  sessionId: string;
  displayName: string;
  email: string;
}

export interface TestData {
  customer: { id: string; name: string; externalKey: string };
  manager: TestAccount;
  user: TestAccount;
  roles: { managerId: number; userId: number };
}

// ---------------------------------------------------------------------------
// Pool management
// ---------------------------------------------------------------------------

let pool: Pool | null = null;

function getPool(): Pool {
  if (!pool) {
    const url = process.env.DATABASE_MIGRATION_URL ?? process.env.DATABASE_URL;
    if (!url) {
      throw new Error(
        "DATABASE_MIGRATION_URL or DATABASE_URL must be set for E2E fixtures",
      );
    }
    pool = new Pool({ connectionString: url });
  }
  return pool;
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

// ---------------------------------------------------------------------------
// Seed & cleanup
// ---------------------------------------------------------------------------

export async function seedTestData(): Promise<TestData> {
  const p = getPool();
  const suffix = randomUUID().slice(0, 8);

  // Look up built-in role IDs
  const roles = await p.query<{ id: number; name: string }>(
    `SELECT id, name FROM roles
     WHERE name IN ('Manager', 'User') AND auth_context = 'general'`,
  );
  const managerRole = roles.rows.find((r) => r.name === "Manager");
  const userRole = roles.rows.find((r) => r.name === "User");
  if (!managerRole || !userRole) {
    throw new Error("Built-in Manager/User roles not found in database");
  }
  const managerRoleId = managerRole.id;
  const userRoleId = userRole.id;

  // Customer
  const customerId = randomUUID();
  const customerName = `E2E Customer ${suffix}`;
  const externalKey = `e2e-${suffix}`;
  await p.query(
    `INSERT INTO customers (id, external_key, name, status, database_status)
     VALUES ($1, $2, $3, 'active', 'active')`,
    [customerId, externalKey, customerName],
  );

  // Manager account
  const mgrAccountId = randomUUID();
  const mgrDisplayName = `E2E Manager ${suffix}`;
  const mgrEmail = `mgr-${suffix}@e2e.test`;
  await p.query(
    `INSERT INTO accounts
       (id, oidc_issuer, oidc_subject, username, display_name, email, status)
     VALUES ($1, 'e2e-issuer', $2, $3, $4, $5, 'active')`,
    [mgrAccountId, `mgr-${suffix}`, `mgr-${suffix}`, mgrDisplayName, mgrEmail],
  );

  // User account
  const usrAccountId = randomUUID();
  const usrDisplayName = `E2E User ${suffix}`;
  const usrEmail = `usr-${suffix}@e2e.test`;
  await p.query(
    `INSERT INTO accounts
       (id, oidc_issuer, oidc_subject, username, display_name, email, status)
     VALUES ($1, 'e2e-issuer', $2, $3, $4, $5, 'active')`,
    [usrAccountId, `usr-${suffix}`, `usr-${suffix}`, usrDisplayName, usrEmail],
  );

  // Memberships
  await p.query(
    `INSERT INTO account_customer_memberships (account_id, customer_id, role_id)
     VALUES ($1, $2, $3), ($4, $2, $5)`,
    [mgrAccountId, customerId, managerRoleId, usrAccountId, userRoleId],
  );

  // Sessions
  const mgrSession = await p.query<{ sid: string }>(
    `INSERT INTO sessions (account_id, auth_context, ip_address, user_agent)
     VALUES ($1, 'general', '127.0.0.1', 'Playwright E2E')
     RETURNING sid`,
    [mgrAccountId],
  );
  const usrSession = await p.query<{ sid: string }>(
    `INSERT INTO sessions (account_id, auth_context, ip_address, user_agent)
     VALUES ($1, 'general', '127.0.0.1', 'Playwright E2E')
     RETURNING sid`,
    [usrAccountId],
  );

  return {
    customer: { id: customerId, name: customerName, externalKey },
    manager: {
      accountId: mgrAccountId,
      sessionId: mgrSession.rows[0].sid,
      displayName: mgrDisplayName,
      email: mgrEmail,
    },
    user: {
      accountId: usrAccountId,
      sessionId: usrSession.rows[0].sid,
      displayName: usrDisplayName,
      email: usrEmail,
    },
    roles: { managerId: managerRoleId, userId: userRoleId },
  };
}

export async function cleanupTestData(data: TestData): Promise<void> {
  const p = getPool();
  const accountIds = [data.manager.accountId, data.user.accountId];

  // Delete in reverse dependency order.
  // Invitations may have been created during tests (e.g. invite dialog test).
  await p.query(`DELETE FROM invitations WHERE customer_id = $1`, [
    data.customer.id,
  ]);
  await p.query(`DELETE FROM sessions WHERE account_id = ANY($1)`, [
    accountIds,
  ]);
  await p.query(
    `DELETE FROM account_customer_memberships WHERE customer_id = $1`,
    [data.customer.id],
  );
  await p.query(`DELETE FROM accounts WHERE id = ANY($1)`, [accountIds]);
  await p.query(`DELETE FROM customers WHERE id = $1`, [data.customer.id]);
}
