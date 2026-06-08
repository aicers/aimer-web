// Per-customer default analysis model resolution (#473).
//
// The default `(model_name, model)` pair used for new analyses and for
// default-omitting force-regenerate / backfill calls used to be read
// straight from env (`ANALYSIS_DEFAULT_MODEL_NAME` /
// `ANALYSIS_DEFAULT_MODEL`) via `getDefaultModelPair()`. That getter is
// synchronous and now re-scoped to env/catalog allow-list duties only
// (see `model-catalog.ts`).
//
// `resolveDefaultModel(customerId)` is the async replacement that
// implements the three-tier resolution order:
//
//   1. per-customer override  — `customer_default_model` row
//   2. admin-set global       — `system_settings.analysis_default_model`
//   3. env fallback           — `ANALYSIS_DEFAULT_MODEL_NAME` / `_MODEL`
//
// Catalog membership is enforced TWICE: the setter APIs below block an
// invalid `(model_name, model)` at save time, and the resolver is
// additionally DEFENSIVE — a stale/invalid stored value (e.g. a catalog
// entry removed from env after it was saved) is logged and skipped so
// resolution falls through to the next tier rather than 500ing. The env
// tier is the trusted base (the catalog always contains the env default)
// and is returned as-is.
//
// SERVER-ONLY. Reads the auth DB and the (server-only) model catalog.

import "server-only";

import type { Pool, PoolClient } from "pg";
import { auditLog } from "../audit";
import { assertAuthorized } from "../auth/authorization";
import { HttpError } from "../auth/errors";
import { getAuthPool } from "../db/client";
import { isModelAllowed } from "./model-catalog";

/** A resolved analysis-model variant pair. */
export interface ModelPair {
  modelName: string;
  model: string;
}

/** `system_settings` key holding the admin-set global default. */
export const GLOBAL_DEFAULT_MODEL_KEY = "analysis_default_model";

/** Permission key gating per-customer default-model read/write (#473). */
const PERM_READ = "customer-default-model:read";
const PERM_WRITE = "customer-default-model:write";

const ENV_DEFAULT_MODEL_NAME =
  process.env.ANALYSIS_DEFAULT_MODEL_NAME ?? "openai";
const ENV_DEFAULT_MODEL = process.env.ANALYSIS_DEFAULT_MODEL ?? "gpt-4o";

/**
 * The env-level fallback pair — the ultimate (third-tier) default,
 * always present in `ANALYSIS_MODEL_CATALOG`. Never read from the DB.
 */
export function getEnvDefaultModel(): ModelPair {
  return { modelName: ENV_DEFAULT_MODEL_NAME, model: ENV_DEFAULT_MODEL };
}

// A Pool or a checked-out PoolClient — both expose `.query`.
type Queryable = Pool | PoolClient;

function logResolverEvent(
  event: string,
  customerId: string,
  detail: Record<string, unknown>,
): void {
  console.warn(
    JSON.stringify({
      level: "warn",
      event: `analysis.default_model.${event}`,
      customer_id: customerId,
      ...detail,
    }),
  );
}

/**
 * Coerce an arbitrary stored value into a `ModelPair`, or `null` if it
 * is not a well-formed `{ modelName, model }` object. Used for both the
 * per-customer row and the global `system_settings` JSONB value.
 */
function coercePair(value: unknown): ModelPair | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const obj = value as Record<string, unknown>;
  const modelName = obj.modelName;
  const model = obj.model;
  if (typeof modelName !== "string" || modelName.length === 0) return null;
  if (typeof model !== "string" || model.length === 0) return null;
  return { modelName, model };
}

/**
 * Resolve the default `(modelName, model)` for `customerId` per the
 * three-tier order (customer override → admin global → env). Defensive
 * at every DB tier: a missing, malformed, or non-catalog stored value is
 * logged and skipped, never thrown. Always returns a pair — the env
 * default is the guaranteed floor.
 *
 * @param db optional Pool/PoolClient to run on (defaults to the auth
 *   pool). Pass the loader's transaction client to share its connection.
 */
export async function resolveDefaultModel(
  customerId: string,
  db: Queryable = getAuthPool(),
): Promise<ModelPair> {
  // Tier 1: per-customer override.
  try {
    const res = await db.query<{ model_name: string; model: string }>(
      `SELECT model_name, model
         FROM customer_default_model
        WHERE customer_id = $1`,
      [customerId],
    );
    if (res.rows.length > 0) {
      const pair = {
        modelName: res.rows[0].model_name,
        model: res.rows[0].model,
      };
      if (isModelAllowed(pair.modelName, pair.model)) return pair;
      logResolverEvent("stale_customer_override", customerId, {
        stored: pair,
        action: "fell back to global/env",
      });
    }
  } catch (err) {
    logResolverEvent("customer_lookup_failed", customerId, {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // Tier 2: admin-set global default.
  try {
    const res = await db.query<{ value: unknown }>(
      `SELECT value FROM system_settings WHERE key = $1`,
      [GLOBAL_DEFAULT_MODEL_KEY],
    );
    if (res.rows.length > 0) {
      const pair = coercePair(res.rows[0].value);
      if (pair && isModelAllowed(pair.modelName, pair.model)) return pair;
      logResolverEvent("stale_global_default", customerId, {
        stored: res.rows[0].value,
        action: "fell back to env",
      });
    }
  } catch (err) {
    logResolverEvent("global_lookup_failed", customerId, {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // Tier 3: env fallback (trusted base, always in the catalog).
  return getEnvDefaultModel();
}

// ---------------------------------------------------------------------------
// Setter / reader services (used by the settings APIs)
// ---------------------------------------------------------------------------

/**
 * Validate a request body into a catalog-allowed `ModelPair`. Throws
 * `HttpError` 400 on a malformed body, 422 when the pair is not in
 * `ANALYSIS_MODEL_CATALOG` (block-at-save, acceptance criterion 3).
 */
export function parseModelPairInput(input: unknown): ModelPair {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new HttpError("Request body must be a JSON object", 400);
  }
  const obj = input as Record<string, unknown>;
  const modelName = obj.modelName;
  const model = obj.model;
  if (typeof modelName !== "string" || modelName.length === 0) {
    throw new HttpError("modelName is required", 400);
  }
  if (typeof model !== "string" || model.length === 0) {
    throw new HttpError("model is required", 400);
  }
  if (!isModelAllowed(modelName, model)) {
    throw new HttpError("model_not_in_catalog", 422);
  }
  return { modelName, model };
}

/** Read the admin-set global default, or `null` if unset/malformed. */
export async function readGlobalDefaultModel(
  client: PoolClient,
): Promise<ModelPair | null> {
  const res = await client.query<{ value: unknown }>(
    `SELECT value FROM system_settings WHERE key = $1`,
    [GLOBAL_DEFAULT_MODEL_KEY],
  );
  if (res.rows.length === 0) return null;
  return coercePair(res.rows[0].value);
}

/**
 * Set the admin-set global default. Admin context only
 * (`system-settings:write`). Validates catalog membership at save.
 */
export async function setGlobalDefaultModel(
  client: PoolClient,
  accountId: string,
  input: unknown,
  auditMeta?: { ipAddress: string; sid: string },
): Promise<ModelPair> {
  await assertAuthorized(client, "admin", accountId, "system-settings:write");
  const pair = parseModelPairInput(input);
  const prev = await readGlobalDefaultModel(client);
  await client.query(
    `INSERT INTO system_settings (key, value, updated_at)
     VALUES ($1, $2::jsonb, NOW())
     ON CONFLICT (key)
     DO UPDATE SET value = $2::jsonb, updated_at = NOW()`,
    [GLOBAL_DEFAULT_MODEL_KEY, JSON.stringify(pair)],
  );
  void auditLog({
    actorId: accountId,
    authContext: "admin",
    action: "system.default_model_updated",
    targetType: "system_settings",
    targetId: GLOBAL_DEFAULT_MODEL_KEY,
    ipAddress: auditMeta?.ipAddress,
    sid: auditMeta?.sid,
    details: { before: prev, after: pair },
  });
  return pair;
}

/** Clear the admin-set global default (revert global resolution to env). */
export async function clearGlobalDefaultModel(
  client: PoolClient,
  accountId: string,
  auditMeta?: { ipAddress: string; sid: string },
): Promise<{ cleared: boolean }> {
  await assertAuthorized(client, "admin", accountId, "system-settings:write");
  const prev = await readGlobalDefaultModel(client);
  const res = await client.query(`DELETE FROM system_settings WHERE key = $1`, [
    GLOBAL_DEFAULT_MODEL_KEY,
  ]);
  const cleared = (res.rowCount ?? 0) > 0;
  if (cleared) {
    void auditLog({
      actorId: accountId,
      authContext: "admin",
      action: "system.default_model_cleared",
      targetType: "system_settings",
      targetId: GLOBAL_DEFAULT_MODEL_KEY,
      ipAddress: auditMeta?.ipAddress,
      sid: auditMeta?.sid,
      details: { before: prev },
    });
  }
  return { cleared };
}

/**
 * The per-customer override permission split crosses auth contexts:
 * System Administrator authorizes through the admin context (any
 * customer); Analyst through the general context (assigned customers
 * only, via the analyst-assignment union in `authorizeGeneral`). Both
 * contexts use the SAME `customer-default-model:*` key, so this single
 * guard serves both routes.
 */
async function authorizeCustomerDefaultModel(
  client: PoolClient,
  authContext: "general" | "admin",
  accountId: string,
  customerId: string,
  op: "read" | "write",
): Promise<void> {
  const permission = op === "write" ? PERM_WRITE : PERM_READ;
  if (authContext === "admin") {
    await assertAuthorized(client, "admin", accountId, permission);
    return;
  }
  await assertAuthorized(client, "general", accountId, permission, {
    customerId,
    operationKind: op,
  });
}

async function assertCustomerExists(
  client: PoolClient,
  customerId: string,
): Promise<void> {
  const res = await client.query(`SELECT 1 FROM customers WHERE id = $1`, [
    customerId,
  ]);
  if (res.rows.length === 0) {
    throw new HttpError("Customer not found", 404);
  }
}

export interface CustomerDefaultModelView {
  /** The stored override, or `null` when the customer has none. */
  override: ModelPair | null;
  /** The effective resolved default (override → global → env). */
  effective: ModelPair;
  /** Where `effective` came from. */
  source: "customer" | "global" | "env";
}

/**
 * Read a customer's override (if any) plus the effective resolved
 * default and which tier supplied it. Authorizes read access.
 */
export async function readCustomerDefaultModel(
  client: PoolClient,
  authContext: "general" | "admin",
  accountId: string,
  customerId: string,
): Promise<CustomerDefaultModelView> {
  await authorizeCustomerDefaultModel(
    client,
    authContext,
    accountId,
    customerId,
    "read",
  );

  const res = await client.query<{ model_name: string; model: string }>(
    `SELECT model_name, model
       FROM customer_default_model
      WHERE customer_id = $1`,
    [customerId],
  );
  let override: ModelPair | null = null;
  if (res.rows.length > 0) {
    const pair = {
      modelName: res.rows[0].model_name,
      model: res.rows[0].model,
    };
    // Surface a stale override as "no override" so the UI does not
    // present a value the resolver would itself skip.
    override = isModelAllowed(pair.modelName, pair.model) ? pair : null;
  }

  if (override) {
    return { override, effective: override, source: "customer" };
  }
  const global = await readGlobalDefaultModel(client);
  if (global && isModelAllowed(global.modelName, global.model)) {
    return { override: null, effective: global, source: "global" };
  }
  return { override: null, effective: getEnvDefaultModel(), source: "env" };
}

/**
 * Set a customer's per-customer override. Authorizes write access
 * (Admin any customer; Analyst assigned customers). Validates catalog
 * membership at save and records `updated_by`. Returns whether the
 * value actually changed (for no-op-aware audit emission).
 */
export async function setCustomerDefaultModel(
  client: PoolClient,
  authContext: "general" | "admin",
  accountId: string,
  customerId: string,
  input: unknown,
  auditMeta?: { ipAddress: string; sid: string },
): Promise<{ pair: ModelPair; changed: boolean }> {
  await authorizeCustomerDefaultModel(
    client,
    authContext,
    accountId,
    customerId,
    "write",
  );
  await assertCustomerExists(client, customerId);
  const pair = parseModelPairInput(input);

  const before = await client.query<{ model_name: string; model: string }>(
    `SELECT model_name, model
       FROM customer_default_model
      WHERE customer_id = $1`,
    [customerId],
  );
  const prev = before.rows[0]
    ? { modelName: before.rows[0].model_name, model: before.rows[0].model }
    : null;
  const changed =
    !prev || prev.modelName !== pair.modelName || prev.model !== pair.model;

  if (changed) {
    await client.query(
      `INSERT INTO customer_default_model
         (customer_id, model_name, model, updated_at, updated_by)
       VALUES ($1, $2, $3, NOW(), $4)
       ON CONFLICT (customer_id)
       DO UPDATE SET model_name = $2, model = $3,
                     updated_at = NOW(), updated_by = $4`,
      [customerId, pair.modelName, pair.model, accountId],
    );
    void auditLog({
      actorId: accountId,
      authContext,
      action: "customer_default_model.updated",
      targetType: "customer_default_model",
      targetId: customerId,
      customerId,
      ipAddress: auditMeta?.ipAddress,
      sid: auditMeta?.sid,
      details: { customerId, before: prev, after: pair },
    });
  }
  return { pair, changed };
}

/**
 * Clear a customer's per-customer override (delete the row), reverting
 * the customer to the global default. Authorizes write access. Returns
 * whether a row was actually removed.
 */
export async function clearCustomerDefaultModel(
  client: PoolClient,
  authContext: "general" | "admin",
  accountId: string,
  customerId: string,
  auditMeta?: { ipAddress: string; sid: string },
): Promise<{ cleared: boolean }> {
  await authorizeCustomerDefaultModel(
    client,
    authContext,
    accountId,
    customerId,
    "write",
  );
  const before = await client.query<{ model_name: string; model: string }>(
    `SELECT model_name, model
       FROM customer_default_model
      WHERE customer_id = $1`,
    [customerId],
  );
  if (before.rows.length === 0) {
    return { cleared: false };
  }
  await client.query(
    `DELETE FROM customer_default_model WHERE customer_id = $1`,
    [customerId],
  );
  void auditLog({
    actorId: accountId,
    authContext,
    action: "customer_default_model.cleared",
    targetType: "customer_default_model",
    targetId: customerId,
    customerId,
    ipAddress: auditMeta?.ipAddress,
    sid: auditMeta?.sid,
    details: {
      customerId,
      before: {
        modelName: before.rows[0].model_name,
        model: before.rows[0].model,
      },
    },
  });
  return { cleared: true };
}
