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
  customerB: { id: string; name: string; externalKey: string };
  manager: TestAccount;
  user: TestAccount;
  analyst: TestAccount;
  admin: TestAccount;
  multiRole: TestAccount;
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

  // Customer B (for multi-role testing)
  const customerBId = randomUUID();
  const customerBName = `E2E Customer B ${suffix}`;
  const customerBKey = `e2e-b-${suffix}`;
  await p.query(
    `INSERT INTO customers (id, external_key, name, status, database_status)
     VALUES ($1, $2, $3, 'active', 'active')`,
    [customerBId, customerBKey, customerBName],
  );

  // Analyst account (analyst_eligible=true, assigned to customer A)
  const analystAccountId = randomUUID();
  const analystDisplayName = `E2E Analyst ${suffix}`;
  const analystEmail = `analyst-${suffix}@e2e.test`;
  await p.query(
    `INSERT INTO accounts
       (id, oidc_issuer, oidc_subject, username, display_name, email, status, analyst_eligible)
     VALUES ($1, 'e2e-issuer', $2, $3, $4, $5, 'active', true)`,
    [
      analystAccountId,
      `analyst-${suffix}`,
      `analyst-${suffix}`,
      analystDisplayName,
      analystEmail,
    ],
  );
  await p.query(
    `INSERT INTO analyst_customer_assignments (account_id, customer_id, assigned_by)
     VALUES ($1, $2, $3)`,
    [analystAccountId, customerId, mgrAccountId],
  );

  // Admin account (admin_eligible=true)
  const adminAccountId = randomUUID();
  const adminDisplayName = `E2E Admin ${suffix}`;
  const adminEmail = `admin-${suffix}@e2e.test`;
  await p.query(
    `INSERT INTO accounts
       (id, oidc_issuer, oidc_subject, username, display_name, email, status, admin_eligible)
     VALUES ($1, 'e2e-issuer', $2, $3, $4, $5, 'active', true)`,
    [
      adminAccountId,
      `admin-${suffix}`,
      `admin-${suffix}`,
      adminDisplayName,
      adminEmail,
    ],
  );

  // Multi-role account: User in customer A, Manager in customer B
  const multiAccountId = randomUUID();
  const multiDisplayName = `E2E Multi ${suffix}`;
  const multiEmail = `multi-${suffix}@e2e.test`;
  await p.query(
    `INSERT INTO accounts
       (id, oidc_issuer, oidc_subject, username, display_name, email, status)
     VALUES ($1, 'e2e-issuer', $2, $3, $4, $5, 'active')`,
    [
      multiAccountId,
      `multi-${suffix}`,
      `multi-${suffix}`,
      multiDisplayName,
      multiEmail,
    ],
  );
  await p.query(
    `INSERT INTO account_customer_memberships (account_id, customer_id, role_id)
     VALUES ($1, $2, $3), ($1, $4, $5)`,
    [multiAccountId, customerId, userRoleId, customerBId, managerRoleId],
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
  const analystSession = await p.query<{ sid: string }>(
    `INSERT INTO sessions (account_id, auth_context, ip_address, user_agent)
     VALUES ($1, 'general', '127.0.0.1', 'Playwright E2E')
     RETURNING sid`,
    [analystAccountId],
  );
  const adminSession = await p.query<{ sid: string }>(
    `INSERT INTO sessions (account_id, auth_context, ip_address, user_agent)
     VALUES ($1, 'admin', '127.0.0.1', 'Playwright E2E')
     RETURNING sid`,
    [adminAccountId],
  );
  const multiSession = await p.query<{ sid: string }>(
    `INSERT INTO sessions (account_id, auth_context, ip_address, user_agent)
     VALUES ($1, 'general', '127.0.0.1', 'Playwright E2E')
     RETURNING sid`,
    [multiAccountId],
  );

  return {
    customer: { id: customerId, name: customerName, externalKey },
    customerB: {
      id: customerBId,
      name: customerBName,
      externalKey: customerBKey,
    },
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
    analyst: {
      accountId: analystAccountId,
      sessionId: analystSession.rows[0].sid,
      displayName: analystDisplayName,
      email: analystEmail,
    },
    admin: {
      accountId: adminAccountId,
      sessionId: adminSession.rows[0].sid,
      displayName: adminDisplayName,
      email: adminEmail,
    },
    multiRole: {
      accountId: multiAccountId,
      sessionId: multiSession.rows[0].sid,
      displayName: multiDisplayName,
      email: multiEmail,
    },
    roles: { managerId: managerRoleId, userId: userRoleId },
  };
}

export async function cleanupTestData(data: TestData): Promise<void> {
  const p = getPool();
  const accountIds = [
    data.manager.accountId,
    data.user.accountId,
    data.analyst.accountId,
    data.admin.accountId,
    data.multiRole.accountId,
  ];
  const customerIds = [data.customer.id, data.customerB.id];

  // Delete in reverse dependency order.
  await p.query(`DELETE FROM invitations WHERE customer_id = ANY($1)`, [
    customerIds,
  ]);
  await p.query(
    `DELETE FROM analyst_customer_assignments WHERE account_id = ANY($1)`,
    [accountIds],
  );
  await p.query(`DELETE FROM sessions WHERE account_id = ANY($1)`, [
    accountIds,
  ]);
  await p.query(
    `DELETE FROM account_customer_memberships WHERE customer_id = ANY($1)`,
    [customerIds],
  );
  await p.query(`DELETE FROM accounts WHERE id = ANY($1)`, [accountIds]);
  await p.query(`DELETE FROM customers WHERE id = ANY($1)`, [customerIds]);
}

/**
 * Get a fresh DB pool for direct queries in E2E tests (e.g., updating
 * admin_eligible mid-test). Uses the same pool as seedTestData.
 */
export function getTestPool(): Pool {
  return getPool();
}
