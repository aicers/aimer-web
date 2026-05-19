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

export interface UpdateCustomerParams {
  name?: string;
  description?: string | null;
  externalKey?: string;
}

export interface UpdatedCustomer {
  id: string;
  name: string;
  externalKey: string;
  description: string | null;
  status: string;
  databaseStatus: string;
  changedFields: ("name" | "description" | "external_key")[];
  previous: {
    name?: string;
    description?: string | null;
    external_key?: string;
  };
  next: { name?: string; description?: string | null; external_key?: string };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const EXTERNAL_KEY_MAX_LEN = 256;
const NAME_MAX_LEN = 256;
const DESCRIPTION_MAX_LEN = 1024;
// Reject ASCII control characters (0x00-0x1F, 0x7F).
// biome-ignore lint/suspicious/noControlCharactersInRegex: validation against control chars
const CONTROL_CHARS_RE = /[\x00-\x1F\x7F]/;

export interface ValidatedCustomerFields {
  name?: string;
  description?: string | null;
  externalKey?: string;
}

/**
 * Trim and validate customer fields. Returns the trimmed values that
 * should be persisted. Throws HttpError(400) with a typed error code
 * on failure.
 *
 * For optional fields, pass `undefined` to skip; pass an empty/whitespace
 * value to trigger the rejection (the caller's job is to decide whether
 * a missing field means "leave unchanged" vs. "clear to empty").
 *
 * `description` accepts an empty string after trim (interpreted as null).
 */
export function validateCustomerFields(
  raw: { name?: unknown; description?: unknown; externalKey?: unknown },
  opts: { requireAll?: boolean } = {},
): ValidatedCustomerFields {
  const out: ValidatedCustomerFields = {};

  if (raw.name !== undefined) {
    if (typeof raw.name !== "string") {
      throw new HttpError("name must be a string", 400);
    }
    const trimmed = raw.name.trim();
    if (!trimmed) {
      throw new HttpError("name_required", 400);
    }
    if (CONTROL_CHARS_RE.test(trimmed)) {
      throw new HttpError("name_invalid_characters", 400);
    }
    if (trimmed.length > NAME_MAX_LEN) {
      throw new HttpError("name_too_long", 400);
    }
    out.name = trimmed;
  } else if (opts.requireAll) {
    throw new HttpError("name_required", 400);
  }

  if (raw.description !== undefined) {
    if (raw.description === null) {
      out.description = null;
    } else if (typeof raw.description !== "string") {
      throw new HttpError("description must be a string", 400);
    } else {
      const trimmed = raw.description.trim();
      if (CONTROL_CHARS_RE.test(trimmed)) {
        throw new HttpError("description_invalid_characters", 400);
      }
      if (trimmed.length > DESCRIPTION_MAX_LEN) {
        throw new HttpError("description_too_long", 400);
      }
      out.description = trimmed === "" ? null : trimmed;
    }
  }

  if (raw.externalKey !== undefined) {
    if (typeof raw.externalKey !== "string") {
      throw new HttpError("externalKey must be a string", 400);
    }
    const trimmed = raw.externalKey.trim();
    if (!trimmed) {
      throw new HttpError("external_key_required", 400);
    }
    if (CONTROL_CHARS_RE.test(trimmed)) {
      throw new HttpError("external_key_invalid_characters", 400);
    }
    if (trimmed.length > EXTERNAL_KEY_MAX_LEN) {
      throw new HttpError("external_key_too_long", 400);
    }
    out.externalKey = trimmed;
  } else if (opts.requireAll) {
    throw new HttpError("external_key_required", 400);
  }

  return out;
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
// Lookup customer by external_key
// ---------------------------------------------------------------------------

/**
 * Resolve a customer row from its `external_key`. Returns `null` if no
 * row matches. Unlike {@link getCustomerOrFail}, this performs no
 * status checks — the caller decides whether `provisioning` / `failed`
 * is acceptable for its use case.
 */
export async function getCustomerByExternalKey(
  pool: Pool,
  externalKey: string,
): Promise<CustomerRow | null> {
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
     FROM customers WHERE external_key = $1`,
    [externalKey],
  );

  if (result.rows.length === 0) return null;

  const row = result.rows[0];
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

    // Auto-insert the retention policy row. Both the retention
    // sweeper and the settings UI treat absence as a bug — the row
    // must exist from the moment a customer exists. analysis_days
    // is supplied explicitly (1095 ≈ 36 months); the column default
    // is NULL ("unlimited"), reserved for operator opt-in.
    await client.query(
      `INSERT INTO customer_retention_policy
         (customer_id, ingestion_days, analysis_days, updated_by)
       VALUES ($1, 365, 1095, $2)`,
      [customerId, params.managerAccountId],
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

// ---------------------------------------------------------------------------
// Update customer (transactional)
// ---------------------------------------------------------------------------

/**
 * Update mutable customer fields. Only fields present in `params`
 * (i.e. not `undefined`) are written. Returns the resulting row plus
 * `changedFields` / `previous` / `next` snapshots for audit consumers,
 * including only the fields that actually changed value.
 *
 * @throws HttpError 404 if customer not found.
 * @throws HttpError 409 if `external_key` collides with an existing row.
 */
export async function updateCustomer(
  client: PoolClient,
  customerId: string,
  params: UpdateCustomerParams,
): Promise<UpdatedCustomer> {
  const current = await client.query<{
    id: string;
    name: string;
    external_key: string;
    description: string | null;
    status: string;
    database_status: string;
  }>(
    `SELECT id, name, external_key, description, status, database_status
     FROM customers WHERE id = $1 FOR UPDATE`,
    [customerId],
  );

  if (current.rows.length === 0) {
    throw new HttpError("Customer not found", 404);
  }

  const row = current.rows[0];

  const setClauses: string[] = [];
  const values: unknown[] = [];
  const changedFields: ("name" | "description" | "external_key")[] = [];
  const previous: UpdatedCustomer["previous"] = {};
  const next: UpdatedCustomer["next"] = {};

  if (params.name !== undefined && params.name !== row.name) {
    values.push(params.name);
    setClauses.push(`name = $${values.length}`);
    changedFields.push("name");
    previous.name = row.name;
    next.name = params.name;
  }

  if (
    params.description !== undefined &&
    params.description !== row.description
  ) {
    values.push(params.description);
    setClauses.push(`description = $${values.length}`);
    changedFields.push("description");
    previous.description = row.description;
    next.description = params.description;
  }

  if (
    params.externalKey !== undefined &&
    params.externalKey !== row.external_key
  ) {
    values.push(params.externalKey);
    setClauses.push(`external_key = $${values.length}`);
    changedFields.push("external_key");
    previous.external_key = row.external_key;
    next.external_key = params.externalKey;
  }

  let updated = row;
  if (setClauses.length > 0) {
    values.push(customerId);
    try {
      const result = await client.query<{
        id: string;
        name: string;
        external_key: string;
        description: string | null;
        status: string;
        database_status: string;
      }>(
        `UPDATE customers
         SET ${setClauses.join(", ")}, updated_at = NOW()
         WHERE id = $${values.length}
         RETURNING id, name, external_key, description, status, database_status`,
        values,
      );
      updated = result.rows[0];
    } catch (err: unknown) {
      const pgErr = err as { code?: string; constraint?: string };
      if (
        pgErr.code === "23505" &&
        pgErr.constraint === "customers_external_key_key"
      ) {
        throw new HttpError("external_key_conflict", 409);
      }
      throw err;
    }
  }

  return {
    id: updated.id,
    name: updated.name,
    externalKey: updated.external_key,
    description: updated.description,
    status: updated.status,
    databaseStatus: updated.database_status,
    changedFields,
    previous,
    next,
  };
}
