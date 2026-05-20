import "server-only";

import type { Pool, PoolClient } from "pg";
import { encryptPayload } from "../crypto/envelope";
import { query, withTransaction } from "../db/client";
import { loadPARByConnectionIdWithClient } from "./analyze-bridge";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PendingConnection {
  connectionId: string;
  jti: string;
  issuer: string;
  aiceId: string;
  customerIds: string[];
  sub: string | null;
  status: string;
  expiresAt: Date;
}

export interface BridgeCallbackResult {
  deny?: string;
  sessionId?: string;
  bridgeAiceId?: string;
  bridgeCustomerIds?: string[];
  /**
   * external_key values the sender claimed scope to, taken from
   * `pending_connections.customer_ids`. Populated on every scope-probing
   * denial path so audit can preserve forensic context.
   */
  requestedCustomerExternalKeys?: string[];
  /**
   * Subset of `requestedCustomerExternalKeys` that resolved against
   * `aice_environment_customers JOIN customers` for the bridge's
   * `aice_id`. Independent of customer / environment status — a key
   * whose customer or environment is inactive is still listed here
   * because it was found; the denial reason itself encodes the
   * status-related rejection.
   */
  matchedCustomerExternalKeys?: string[];
  /**
   * Set when a `pending_analysis_requests` row exists for this
   * connection — i.e. the bridge entry came from the analyze-bridge
   * wrapping endpoint, not the Phase 1 ingest path. The callback
   * redirects to `/api/analysis/analyze-bridge/continue?id=<par_id>`
   * instead of `/` and the Phase 1 `staged_event_customers` insert
   * loop is skipped.
   */
  analyzeRequestId?: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CONNECTION_TTL_SECONDS = 300; // 5 minutes
const JTI_GRACE_PERIOD_HOURS = 24;

// ---------------------------------------------------------------------------
// Create pending connection
// ---------------------------------------------------------------------------

/**
 * Insert a new pending_connections row using an existing transaction
 * client. The jti unique constraint provides replay prevention.
 *
 * Exposed separately so callers that need atomicity with an additional
 * INSERT (e.g. analyze-bridge inserts both `pending_connections` and
 * `pending_analysis_requests` in one transaction) can run both writes
 * on the same `PoolClient`. The {@link createPendingConnection} entry
 * point delegates here under a fresh `withTransaction`.
 */
export async function createPendingConnectionWithClient(
  client: PoolClient,
  params: {
    jti: string;
    issuer: string;
    aiceId: string;
    customerIds: string[];
    sub: string;
  },
): Promise<string> {
  const rows = await client.query<{ connection_id: string }>(
    `INSERT INTO pending_connections (jti, issuer, aice_id, customer_ids, sub, expires_at)
     VALUES ($1, $2, $3, $4, $5, NOW() + INTERVAL '${CONNECTION_TTL_SECONDS} seconds')
     RETURNING connection_id`,
    [params.jti, params.issuer, params.aiceId, params.customerIds, params.sub],
  );
  return rows.rows[0].connection_id;
}

/**
 * Insert a new pending_connections row. The jti unique constraint
 * provides replay prevention.
 */
export async function createPendingConnection(
  pool: Pool,
  params: {
    jti: string;
    issuer: string;
    aiceId: string;
    customerIds: string[];
    sub: string;
  },
): Promise<string> {
  return withTransaction(pool, (client) =>
    createPendingConnectionWithClient(client, params),
  );
}

// ---------------------------------------------------------------------------
// Stage events payload
// ---------------------------------------------------------------------------

/**
 * Encrypt and store a staged event payload linked to a pending connection.
 * The payload is encrypted via OpenBao Transit envelope encryption before
 * storage — the `payload` column holds AES-256-GCM ciphertext and
 * `wrapped_dek` holds the Transit-wrapped data encryption key.
 */
export async function stageEventsPayload(
  pool: Pool,
  params: {
    connectionId: string;
    aiceId: string;
    payloadHash: string;
    payload: Buffer;
    eventCount: number;
    schemaVersion: string;
  },
): Promise<string> {
  const { ciphertext, wrappedDek } = await encryptPayload(params.payload);

  const rows = await query<{ id: string }>(
    pool,
    `INSERT INTO staged_event_payloads
       (connection_id, aice_id, payload_hash, payload, wrapped_dek, event_count, schema_version, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, NOW() + INTERVAL '${CONNECTION_TTL_SECONDS} seconds')
     RETURNING id`,
    [
      params.connectionId,
      params.aiceId,
      params.payloadHash,
      ciphertext,
      wrappedDek,
      params.eventCount,
      params.schemaVersion,
    ],
  );
  return rows[0].id;
}

// ---------------------------------------------------------------------------
// Consume pending connection (atomic, in callback)
// ---------------------------------------------------------------------------

/**
 * Atomically consume a pending connection. Only the first caller
 * succeeds — concurrent attempts get zero rows from the RETURNING
 * clause.
 */
async function atomicConsume(
  client: PoolClient,
  connectionId: string,
): Promise<PendingConnection | null> {
  const result = await client.query<{
    connection_id: string;
    jti: string;
    issuer: string;
    aice_id: string;
    customer_ids: string[];
    sub: string | null;
    status: string;
    expires_at: Date;
  }>(
    `UPDATE pending_connections
     SET status = 'consumed'
     WHERE connection_id = $1
       AND status = 'pending'
       AND expires_at > NOW()
     RETURNING connection_id, jti, issuer, aice_id, customer_ids, sub, status, expires_at`,
    [connectionId],
  );

  if (result.rows.length === 0) return null;

  const row = result.rows[0];
  return {
    connectionId: row.connection_id,
    jti: row.jti,
    issuer: row.issuer,
    aiceId: row.aice_id,
    customerIds: row.customer_ids,
    sub: row.sub,
    expiresAt: row.expires_at,
    status: row.status,
  };
}

async function denyConsumed(
  client: PoolClient,
  connectionId: string,
  reason: string,
  metadata: {
    bridgeAiceId?: string;
    requestedCustomerExternalKeys?: string[];
    matchedCustomerExternalKeys?: string[];
  } = {},
): Promise<BridgeCallbackResult> {
  await client.query(
    `UPDATE pending_connections SET status = 'denied' WHERE connection_id = $1`,
    [connectionId],
  );
  return {
    deny: reason,
    bridgeAiceId: metadata.bridgeAiceId,
    requestedCustomerExternalKeys: metadata.requestedCustomerExternalKeys,
    matchedCustomerExternalKeys: metadata.matchedCustomerExternalKeys,
  };
}

/**
 * Process bridge callback: atomically consume the pending connection,
 * verify customer mappings, create session, and link staged events —
 * all within a single transaction so that a downstream failure rolls
 * back the consume rather than leaving the connection unrecoverable.
 */
export async function processBridgeCallback(
  pool: Pool,
  connectionId: string,
  accountId: string,
  sessionParams: { ipAddress: string; userAgent: string },
): Promise<BridgeCallbackResult> {
  return withTransaction(pool, async (client) => {
    // 1. Atomic consume
    const conn = await atomicConsume(client, connectionId);
    if (!conn) {
      return { deny: "bridge_expired" };
    }

    // 2. Map external customer_ids to internal UUIDs via aice_environment_customers
    //    customer_ids in pending_connections are external_key values.
    //    Single query returns both internal ID and external_key with status info.
    //    Dedupe the requested set: the mapping query uses SELECT DISTINCT,
    //    so without dedupe a duplicate-bearing request would cause a false
    //    `bridge_customer_mismatch` with an empty `requested ∖ matched` and
    //    break audit forensics. `verifyContextToken` already dedupes; this
    //    is defense-in-depth for any path that reaches a pending_connections
    //    row outside that validator.
    const requestedExternalKeys = Array.from(new Set(conn.customerIds));
    const mappingResult = await client.query<{
      customer_id: string;
      external_key: string;
      customer_status: string;
      env_status: string;
    }>(
      `SELECT DISTINCT c.id AS customer_id,
              c.external_key,
              c.status AS customer_status,
              ae.status AS env_status
       FROM aice_environment_customers aec
       JOIN customers c ON c.id = aec.customer_id
       JOIN aice_environments ae ON ae.aice_id = aec.aice_id
       WHERE aec.aice_id = $1
         AND c.external_key = ANY($2::text[])`,
      [conn.aiceId, requestedExternalKeys],
    );

    // 3. Collect all matched rows. `matchedCustomerExternalKeys` is the
    //    set of keys resolved against `aice_environment_customers JOIN
    //    customers` regardless of `customers.status` /
    //    `aice_environments.status` — the denial reason itself encodes
    //    the status-related rejection, so audit can distinguish
    //    "sender typoed an external_key" (requested ∖ matched) from
    //    "the resolved customer is inactive" (still in matched).
    const matchedExternalKeys: string[] = [];
    const matchedCustomerIds: string[] = [];
    let hasInactiveCustomer = false;
    let hasInactiveEnvironment = false;
    for (const row of mappingResult.rows) {
      matchedExternalKeys.push(row.external_key);
      matchedCustomerIds.push(row.customer_id);
      if (row.customer_status !== "active") hasInactiveCustomer = true;
      if (row.env_status !== "active") hasInactiveEnvironment = true;
    }

    const denyMetadata = {
      bridgeAiceId: conn.aiceId,
      requestedCustomerExternalKeys: requestedExternalKeys,
      matchedCustomerExternalKeys: matchedExternalKeys,
    };

    if (matchedExternalKeys.length !== requestedExternalKeys.length) {
      return denyConsumed(
        client,
        connectionId,
        "bridge_customer_mismatch",
        denyMetadata,
      );
    }

    if (hasInactiveCustomer) {
      return denyConsumed(
        client,
        connectionId,
        "bridge_customer_inactive",
        denyMetadata,
      );
    }

    if (hasInactiveEnvironment) {
      return denyConsumed(
        client,
        connectionId,
        "bridge_environment_inactive",
        denyMetadata,
      );
    }

    // 4. Verify account has access to ALL mapped customers
    //    (membership or analyst assignment — single query for all)
    const accessResult = await client.query<{ customer_id: string }>(
      `SELECT customer_id FROM (
         SELECT customer_id FROM account_customer_memberships
         WHERE account_id = $1 AND customer_id = ANY($2::uuid[])
         UNION
         SELECT aca.customer_id FROM analyst_customer_assignments aca
         JOIN accounts a ON a.id = aca.account_id AND a.analyst_eligible = true
         WHERE aca.account_id = $1 AND aca.customer_id = ANY($2::uuid[])
       ) sub`,
      [accountId, matchedCustomerIds],
    );

    const accessibleIds = new Set(accessResult.rows.map((r) => r.customer_id));
    for (const custId of matchedCustomerIds) {
      if (!accessibleIds.has(custId)) {
        return denyConsumed(
          client,
          connectionId,
          "bridge_no_access",
          denyMetadata,
        );
      }
    }

    // 5. Create bridge session (inside transaction so consume rolls back on failure)
    const sessionResult = await client.query<{ sid: string }>(
      `INSERT INTO sessions
         (account_id, auth_context, bridge_aice_id, bridge_customer_ids, ip_address, user_agent)
       VALUES ($1, 'general', $2, $3, $4, $5)
       RETURNING sid`,
      [
        accountId,
        conn.aiceId,
        matchedCustomerIds,
        sessionParams.ipAddress,
        sessionParams.userAgent,
      ],
    );
    const sessionId = sessionResult.rows[0].sid;

    // 6. Decide which downstream linkage runs.
    //    Analyze-bridge connections own their payload inline in
    //    `pending_analysis_requests`; they never write to
    //    `staged_event_payloads`, so the Phase 1 UPDATE would be a
    //    no-op match anyway. Explicit branching keeps the intent
    //    visible to anyone tracing this code, and ensures the per-
    //    customer `staged_event_customers` INSERT loop (which would
    //    surface the connection on the approval queue) is skipped.
    //    No status filter on the PAR lookup — a row in `expired` /
    //    `failed` state must still route through /continue so its
    //    status can be surfaced.
    const par = await loadPARByConnectionIdWithClient(client, connectionId);
    if (par) {
      return {
        sessionId,
        bridgeAiceId: conn.aiceId,
        bridgeCustomerIds: matchedCustomerIds,
        analyzeRequestId: par.id,
      };
    }

    // Phase 1 ingest path — link staged events to the new session.
    const linkedPayloads = await client.query<{ id: string }>(
      `UPDATE staged_event_payloads SET session_id = $1 WHERE connection_id = $2 RETURNING id`,
      [sessionId, connectionId],
    );

    // Create staged_event_customers rows for each (payload, customer) pair.
    for (const payload of linkedPayloads.rows) {
      for (const custId of matchedCustomerIds) {
        await client.query(
          `INSERT INTO staged_event_customers (payload_id, customer_id, status)
           VALUES ($1, $2, 'pending')
           ON CONFLICT (payload_id, customer_id) DO NOTHING`,
          [payload.id, custId],
        );
      }
    }

    return {
      sessionId,
      bridgeAiceId: conn.aiceId,
      bridgeCustomerIds: matchedCustomerIds,
    };
  });
}

// ---------------------------------------------------------------------------
// Deny connection (set status back to denied)
// ---------------------------------------------------------------------------

export async function denyConnection(
  pool: Pool,
  connectionId: string,
): Promise<void> {
  await query(
    pool,
    `UPDATE pending_connections SET status = 'denied' WHERE connection_id = $1`,
    [connectionId],
  );
}

// ---------------------------------------------------------------------------
// Cleanup expired connections
// ---------------------------------------------------------------------------

/**
 * Delete expired pending connections that have passed the jti grace
 * period (24 hours after expires_at). This preserves jti uniqueness
 * for replay prevention during the grace window.
 */
export async function cleanupExpiredConnections(pool: Pool): Promise<number> {
  const result = await pool.query(
    `DELETE FROM pending_connections
     WHERE expires_at < NOW() - INTERVAL '${JTI_GRACE_PERIOD_HOURS} hours'
     RETURNING connection_id`,
  );
  return result.rowCount ?? 0;
}
