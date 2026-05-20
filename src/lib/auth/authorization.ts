import type { PoolClient } from "pg";
import { HttpError } from "./errors";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type OperationKind = "read" | "write" | "ingest" | "process";

export interface AuthorizeOptions {
  customerId?: string;
  aiceId?: string;
  requiresAiceId?: boolean;
  operationKind?: OperationKind;
  /** If false, immediately reject in bridge sessions. Default: true. */
  allowInBridge?: boolean;
  bridgeScope?: { aiceId: string; customerIds: string[] } | null;
}

export interface AuthorizeResult {
  authorized: boolean;
  /** Denial reason when `authorized` is false. */
  reason?: "bridge_write_blocked" | "bridge_not_allowed";
  permissions?: Set<string>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function applyBridgeScope<T extends { id: string }>(
  items: T[],
  bridgeScope?: { aiceId: string; customerIds: string[] } | null,
): T[] {
  if (!bridgeScope) return items;
  const scopeSet = new Set(bridgeScope.customerIds);
  return items.filter((item) => scopeSet.has(item.id));
}

// ---------------------------------------------------------------------------
// authorize — per-request DB authorization
// ---------------------------------------------------------------------------

export async function authorize(
  client: PoolClient,
  authContext: "general" | "admin",
  accountId: string,
  requiredPermission: string,
  options: AuthorizeOptions = {},
): Promise<AuthorizeResult> {
  const {
    customerId,
    aiceId,
    requiresAiceId = false,
    operationKind,
    allowInBridge = true,
    bridgeScope = null,
  } = options;

  // 1. requiresAiceId enforcement
  if (requiresAiceId && !aiceId) {
    return { authorized: false };
  }

  // 2. Bridge scope restriction
  if (bridgeScope) {
    if (!allowInBridge) {
      return { authorized: false, reason: "bridge_not_allowed" };
    }
    if (operationKind === "write" || operationKind === "ingest") {
      return { authorized: false, reason: "bridge_write_blocked" };
    }
    if (customerId && !bridgeScope.customerIds.includes(customerId)) {
      return { authorized: false };
    }
    if (aiceId && aiceId !== bridgeScope.aiceId) {
      return { authorized: false };
    }
  }

  // 3. Admin context
  if (authContext === "admin") {
    return authorizeAdmin(client, accountId, requiredPermission);
  }

  // 4. General context — customerId required
  if (!customerId) {
    return { authorized: false };
  }

  // Verify customer is active
  const customerRows = await client.query<{ status: string }>(
    `SELECT status FROM customers WHERE id = $1`,
    [customerId],
  );
  if (
    customerRows.rows.length === 0 ||
    customerRows.rows[0].status !== "active"
  ) {
    return { authorized: false };
  }

  // 5. aiceId validation (if provided)
  if (aiceId) {
    const envRows = await client.query<{ status: string }>(
      `SELECT status FROM aice_environments WHERE aice_id = $1`,
      [aiceId],
    );
    if (envRows.rows.length === 0 || envRows.rows[0].status !== "active") {
      return { authorized: false };
    }

    const linkRows = await client.query(
      `SELECT 1 FROM aice_environment_customers
       WHERE aice_id = $1 AND customer_id = $2`,
      [aiceId, customerId],
    );
    if (linkRows.rows.length === 0) {
      return { authorized: false };
    }
  }

  // 6. Permission union — membership + analyst
  return authorizeGeneral(client, accountId, customerId, requiredPermission);
}

// ---------------------------------------------------------------------------
// Admin context authorization
// ---------------------------------------------------------------------------

async function authorizeAdmin(
  client: PoolClient,
  accountId: string,
  requiredPermission: string,
): Promise<AuthorizeResult> {
  const accountRows = await client.query<{ admin_eligible: boolean }>(
    `SELECT admin_eligible FROM accounts WHERE id = $1`,
    [accountId],
  );
  if (accountRows.rows.length === 0 || !accountRows.rows[0].admin_eligible) {
    return { authorized: false };
  }

  const permRows = await client.query<{ permission: string }>(
    `SELECT rp.permission
     FROM role_permissions rp
     JOIN roles r ON r.id = rp.role_id
     WHERE r.name = 'System Administrator' AND r.auth_context = 'admin'`,
  );

  const permissions = new Set(permRows.rows.map((r) => r.permission));
  return {
    authorized: permissions.has(requiredPermission),
    permissions,
  };
}

// ---------------------------------------------------------------------------
// General context authorization — union of membership + analyst
// ---------------------------------------------------------------------------

async function authorizeGeneral(
  client: PoolClient,
  accountId: string,
  customerId: string,
  requiredPermission: string,
): Promise<AuthorizeResult> {
  // Single query: union of membership permissions + analyst permissions.
  // Analyst branch requires analyst_eligible=true AND an active assignment.
  const rows = await client.query<{ permission: string }>(
    `SELECT DISTINCT rp.permission
     FROM account_customer_memberships acm
     JOIN role_permissions rp ON rp.role_id = acm.role_id
     WHERE acm.account_id = $1 AND acm.customer_id = $2
     UNION
     SELECT DISTINCT rp.permission
     FROM analyst_customer_assignments aca
     JOIN accounts a ON a.id = aca.account_id AND a.analyst_eligible = true
     JOIN roles r ON r.name = 'Analyst' AND r.auth_context = 'general'
     JOIN role_permissions rp ON rp.role_id = r.id
     WHERE aca.account_id = $1 AND aca.customer_id = $2`,
    [accountId, customerId],
  );

  if (rows.rows.length === 0) {
    return { authorized: false };
  }

  const permissions = new Set(rows.rows.map((r) => r.permission));
  return {
    authorized: permissions.has(requiredPermission),
    permissions,
  };
}

// ---------------------------------------------------------------------------
// listAccessibleCustomers — union of membership + analyst, with bridge scope
// ---------------------------------------------------------------------------

export interface AccessibleCustomer {
  id: string;
  name: string;
  externalKey: string;
}

export interface AccessibleCustomerDetailed extends AccessibleCustomer {
  /** Membership role name (e.g. "User", "Manager"), null if analyst-only. */
  role: string | null;
  /** Whether this account has an active analyst assignment for this customer. */
  isAnalyst: boolean;
  /**
   * Effective permission keys this account holds for this customer:
   * the union of membership-role grants and analyst-assignment grants
   * (same union `authorizeGeneral` computes). Empty array means no
   * grants (the row would not appear at all in that case).
   */
  permissions: string[];
}

export async function listAccessibleCustomers(
  client: PoolClient,
  accountId: string,
  bridgeScope?: { aiceId: string; customerIds: string[] } | null,
): Promise<AccessibleCustomer[]> {
  // Union of membership customers and analyst-assigned customers (active only)
  const rows = await client.query<{
    id: string;
    name: string;
    external_key: string;
  }>(
    `SELECT DISTINCT c.id, c.name, c.external_key
     FROM customers c
     WHERE c.status = 'active'
       AND (
         EXISTS (
           SELECT 1 FROM account_customer_memberships acm
           WHERE acm.account_id = $1 AND acm.customer_id = c.id
         )
         OR EXISTS (
           SELECT 1 FROM analyst_customer_assignments aca
           JOIN accounts a ON a.id = aca.account_id
           WHERE aca.account_id = $1 AND aca.customer_id = c.id
             AND a.analyst_eligible = true
         )
       )
     ORDER BY c.name`,
    [accountId],
  );

  const customers = rows.rows.map((r) => ({
    id: r.id,
    name: r.name,
    externalKey: r.external_key,
  }));

  return applyBridgeScope(customers, bridgeScope);
}

// ---------------------------------------------------------------------------
// listAccessibleCustomersDetailed — with role and analyst info per customer
// ---------------------------------------------------------------------------

export async function listAccessibleCustomersDetailed(
  client: PoolClient,
  accountId: string,
  bridgeScope?: { aiceId: string; customerIds: string[] } | null,
): Promise<AccessibleCustomerDetailed[]> {
  const rows = await client.query<{
    id: string;
    name: string;
    external_key: string;
    role_name: string | null;
    is_analyst: boolean;
  }>(
    `SELECT c.id, c.name, c.external_key,
            r.name AS role_name,
            (aca.account_id IS NOT NULL AND a.analyst_eligible = true) AS is_analyst
     FROM customers c
     LEFT JOIN account_customer_memberships acm
       ON acm.customer_id = c.id AND acm.account_id = $1
     LEFT JOIN roles r ON r.id = acm.role_id
     LEFT JOIN analyst_customer_assignments aca
       ON aca.customer_id = c.id AND aca.account_id = $1
     CROSS JOIN accounts a
     WHERE a.id = $1
       AND c.status = 'active'
       AND (acm.account_id IS NOT NULL
            OR (aca.account_id IS NOT NULL AND a.analyst_eligible = true))
     ORDER BY c.name`,
    [accountId],
  );

  if (rows.rows.length === 0) {
    return [];
  }

  // Compute effective permission keys per customer in a single round
  // trip. Same union as `authorizeGeneral`: membership-role grants ∪
  // analyst-assignment grants (gated by analyst_eligible).
  const permRows = await client.query<{
    customer_id: string;
    permission: string;
  }>(
    `SELECT acm.customer_id, rp.permission
     FROM account_customer_memberships acm
     JOIN role_permissions rp ON rp.role_id = acm.role_id
     WHERE acm.account_id = $1
     UNION
     SELECT aca.customer_id, rp.permission
     FROM analyst_customer_assignments aca
     JOIN accounts a ON a.id = aca.account_id AND a.analyst_eligible = true
     JOIN roles r ON r.name = 'Analyst' AND r.auth_context = 'general'
     JOIN role_permissions rp ON rp.role_id = r.id
     WHERE aca.account_id = $1`,
    [accountId],
  );

  const permsByCustomer = new Map<string, Set<string>>();
  for (const row of permRows.rows) {
    let set = permsByCustomer.get(row.customer_id);
    if (!set) {
      set = new Set();
      permsByCustomer.set(row.customer_id, set);
    }
    set.add(row.permission);
  }

  const customers: AccessibleCustomerDetailed[] = rows.rows.map((r) => ({
    id: r.id,
    name: r.name,
    externalKey: r.external_key,
    role: r.role_name,
    isAnalyst: r.is_analyst,
    permissions: Array.from(permsByCustomer.get(r.id) ?? []).sort(),
  }));

  return applyBridgeScope(customers, bridgeScope);
}

// ---------------------------------------------------------------------------
// listAccessibleEnvironments — environments linked to a customer
// ---------------------------------------------------------------------------

export interface AccessibleEnvironment {
  aiceId: string;
  name: string;
}

export async function listAccessibleEnvironments(
  client: PoolClient,
  accountId: string,
  customerId: string,
  bridgeScope?: { aiceId: string; customerIds: string[] } | null,
): Promise<AccessibleEnvironment[]> {
  // Verify the account has access to this customer (membership or analyst)
  const accessRows = await client.query(
    `SELECT 1 FROM account_customer_memberships
     WHERE account_id = $1 AND customer_id = $2
     UNION ALL
     SELECT 1 FROM analyst_customer_assignments aca
     JOIN accounts a ON a.id = aca.account_id AND a.analyst_eligible = true
     WHERE aca.account_id = $1 AND aca.customer_id = $2
     LIMIT 1`,
    [accountId, customerId],
  );
  if (accessRows.rows.length === 0) {
    return [];
  }

  // Bridge scope: verify customerId is within bridge scope
  if (bridgeScope && !bridgeScope.customerIds.includes(customerId)) {
    return [];
  }

  const rows = await client.query<{
    aice_id: string;
    name: string;
  }>(
    `SELECT ae.aice_id, ae.name
     FROM aice_environments ae
     JOIN aice_environment_customers aec ON aec.aice_id = ae.aice_id
     WHERE aec.customer_id = $1 AND ae.status = 'active'
     ORDER BY ae.name`,
    [customerId],
  );

  let environments = rows.rows.map((r) => ({
    aiceId: r.aice_id,
    name: r.name,
  }));

  // Bridge scope restriction: only the bridge's aice_id
  if (bridgeScope) {
    environments = environments.filter((e) => e.aiceId === bridgeScope.aiceId);
  }

  return environments;
}

// ---------------------------------------------------------------------------
// assertAuthorized — throwing wrapper
// ---------------------------------------------------------------------------

export async function assertAuthorized(
  client: PoolClient,
  authContext: "general" | "admin",
  accountId: string,
  requiredPermission: string,
  options: AuthorizeOptions = {},
): Promise<Set<string>> {
  const result = await authorize(
    client,
    authContext,
    accountId,
    requiredPermission,
    options,
  );
  if (!result.authorized) {
    throw new HttpError("Forbidden", 403);
  }
  return result.permissions ?? new Set();
}
