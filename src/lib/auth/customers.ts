import type { PoolClient } from "pg";
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
