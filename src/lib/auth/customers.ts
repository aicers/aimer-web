import type { Pool, PoolClient } from "pg";
import { HttpError } from "./errors";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CreateCustomerParams {
  name: string;
  externalKey: string;
  description?: string;
  managerAccountId: string;
}

export interface CreatedCustomer {
  id: string;
  name: string;
  externalKey: string;
  status: string;
  databaseStatus: string;
}

export interface CustomerRow {
  id: string;
  externalKey: string;
  name: string;
  description: string | null;
  status: string;
  databaseStatus: string;
  wrappedDek: string | null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function assertAccountExists(
  client: PoolClient,
  accountId: string,
): Promise<void> {
  const result = await client.query(`SELECT 1 FROM accounts WHERE id = $1`, [
    accountId,
  ]);
  if (result.rows.length === 0) {
    throw new HttpError("Account not found", 404);
  }
}

async function resolveManagerRoleId(client: PoolClient): Promise<number> {
  const result = await client.query<{ id: number }>(
    `SELECT id FROM roles WHERE name = 'Manager' AND auth_context = 'general'`,
  );
  if (result.rows.length === 0) {
    throw new HttpError("Manager role not found", 500);
  }
  return result.rows[0].id;
}

// ---------------------------------------------------------------------------
// Get customer with status validation
// ---------------------------------------------------------------------------

/**
 * Fetch a customer by ID, throwing if not found or if the database
 * is not in a usable state.
 *
 * @throws HttpError 404 if customer not found
 * @throws HttpError 503 if database_status is 'provisioning' or 'failed'
 */
export async function getCustomerOrFail(
  pool: Pool,
  customerId: string,
): Promise<CustomerRow> {
  const result = await pool.query<{
    id: string;
    external_key: string;
    name: string;
    description: string | null;
    status: string;
    database_status: string;
    wrapped_dek: string | null;
  }>(
    `SELECT id, external_key, name, description, status, database_status, wrapped_dek
     FROM customers WHERE id = $1`,
    [customerId],
  );

  if (result.rows.length === 0) {
    throw new HttpError("Customer not found", 404);
  }

  const row = result.rows[0];

  if (row.database_status === "failed") {
    throw new HttpError("customer_database_failed", 503);
  }

  if (row.database_status === "provisioning") {
    throw new HttpError("customer_database_provisioning", 503);
  }

  return {
    id: row.id,
    externalKey: row.external_key,
    name: row.name,
    description: row.description,
    status: row.status,
    databaseStatus: row.database_status,
    wrappedDek: row.wrapped_dek,
  };
}

// ---------------------------------------------------------------------------
// Create customer with initial Manager (transactional)
// ---------------------------------------------------------------------------

export async function createCustomer(
  client: PoolClient,
  params: CreateCustomerParams,
): Promise<CreatedCustomer> {
  await assertAccountExists(client, params.managerAccountId);

  const roleId = await resolveManagerRoleId(client);

  // Insert customer
  let customerId: string;
  try {
    const custResult = await client.query<{
      id: string;
      status: string;
      database_status: string;
    }>(
      `INSERT INTO customers (external_key, name, description)
       VALUES ($1, $2, $3)
       RETURNING id, status, database_status`,
      [params.externalKey, params.name, params.description ?? null],
    );
    customerId = custResult.rows[0].id;

    // Insert initial Manager membership
    await client.query(
      `INSERT INTO account_customer_memberships (account_id, customer_id, role_id)
       VALUES ($1, $2, $3)`,
      [params.managerAccountId, customerId, roleId],
    );

    return {
      id: customerId,
      name: params.name,
      externalKey: params.externalKey,
      status: custResult.rows[0].status,
      databaseStatus: custResult.rows[0].database_status,
    };
  } catch (err: unknown) {
    const pgErr = err as { code?: string; constraint?: string };

    // Unique constraint on external_key
    if (
      pgErr.code === "23505" &&
      pgErr.constraint === "customers_external_key_key"
    ) {
      throw new HttpError("external_key_conflict", 409);
    }

    throw err;
  }
}
