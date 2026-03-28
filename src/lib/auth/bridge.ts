import "server-only";

import type { Pool, PoolClient } from "pg";
import { encryptPayload } from "../crypto/envelope";
import { query, withTransaction } from "../db/client";

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
  const rows = await query<{ connection_id: string }>(
    pool,
    `INSERT INTO pending_connections (jti, issuer, aice_id, customer_ids, sub, expires_at)
     VALUES ($1, $2, $3, $4, $5, NOW() + INTERVAL '${CONNECTION_TTL_SECONDS} seconds')
     RETURNING connection_id`,
    [params.jti, params.issuer, params.aiceId, params.customerIds, params.sub],
  );
  return rows[0].connection_id;
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
): Promise<BridgeCallbackResult> {
  await client.query(
    `UPDATE pending_connections SET status = 'denied' WHERE connection_id = $1`,
    [connectionId],
  );
  return { deny: reason };
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
      [conn.aiceId, conn.customerIds],
    );

    // 3. Exact match verification
    const mappedExternalKeys = new Set<string>();
    const mappedCustomerIds: string[] = [];
    for (const row of mappingResult.rows) {
      if (row.customer_status !== "active") {
        return denyConsumed(client, connectionId, "bridge_customer_inactive");
      }
      if (row.env_status !== "active") {
        return denyConsumed(
          client,
          connectionId,
          "bridge_environment_inactive",
        );
      }
      mappedExternalKeys.add(row.external_key);
      mappedCustomerIds.push(row.customer_id);
    }

    if (mappedExternalKeys.size !== conn.customerIds.length) {
      return denyConsumed(client, connectionId, "bridge_customer_mismatch");
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
      [accountId, mappedCustomerIds],
    );

    const accessibleIds = new Set(accessResult.rows.map((r) => r.customer_id));
    for (const custId of mappedCustomerIds) {
      if (!accessibleIds.has(custId)) {
        return denyConsumed(client, connectionId, "bridge_no_access");
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
        mappedCustomerIds,
        sessionParams.ipAddress,
        sessionParams.userAgent,
      ],
    );
    const sessionId = sessionResult.rows[0].sid;

    // 6. Link staged events to the new session
    const linkedPayloads = await client.query<{ id: string }>(
      `UPDATE staged_event_payloads SET session_id = $1 WHERE connection_id = $2 RETURNING id`,
      [sessionId, connectionId],
    );

    // 7. Create staged_event_customers rows for each (payload, customer) pair
    for (const payload of linkedPayloads.rows) {
      for (const custId of mappedCustomerIds) {
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
      bridgeCustomerIds: mappedCustomerIds,
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
