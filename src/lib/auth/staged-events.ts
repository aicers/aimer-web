import "server-only";

import type { Pool, PoolClient } from "pg";
import { decryptPayload } from "../crypto/envelope";
import { query, withTransaction } from "../db/client";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type StagedEventCustomerStatus =
  | "pending"
  | "approved"
  | "rejected"
  | "expired";

export interface StagedEventCustomerSummary {
  customerId: string;
  customerName: string;
  status: StagedEventCustomerStatus;
  approvedAt: Date | null;
}

export interface StagedEventSummary {
  payloadId: string;
  aiceId: string;
  eventCount: number;
  schemaVersion: string;
  createdAt: Date;
  expiresAt: Date;
  customers: StagedEventCustomerSummary[];
}

// ---------------------------------------------------------------------------
// List staged events for a session
// ---------------------------------------------------------------------------

export async function listStagedEventsBySession(
  pool: Pool,
  sessionId: string,
): Promise<StagedEventSummary[]> {
  // Opportunistic cleanup: expire stale pending rows
  await expireStagedEvents(pool);

  const rows = await query<{
    payload_id: string;
    aice_id: string;
    event_count: number;
    schema_version: string;
    created_at: Date;
    expires_at: Date;
    customer_id: string;
    customer_name: string;
    status: StagedEventCustomerStatus;
    approved_at: Date | null;
  }>(
    pool,
    `SELECT p.id AS payload_id,
            p.aice_id,
            p.event_count,
            p.schema_version,
            p.created_at,
            p.expires_at,
            sec.customer_id,
            c.name AS customer_name,
            sec.status,
            sec.approved_at
     FROM staged_event_payloads p
     JOIN staged_event_customers sec ON sec.payload_id = p.id
     JOIN customers c ON c.id = sec.customer_id
     WHERE p.session_id = $1
     ORDER BY p.created_at DESC, c.name`,
    [sessionId],
  );

  // Group by payload_id
  const map = new Map<string, StagedEventSummary>();
  for (const row of rows) {
    let summary = map.get(row.payload_id);
    if (!summary) {
      summary = {
        payloadId: row.payload_id,
        aiceId: row.aice_id,
        eventCount: row.event_count,
        schemaVersion: row.schema_version,
        createdAt: row.created_at,
        expiresAt: row.expires_at,
        customers: [],
      };
      map.set(row.payload_id, summary);
    }
    summary.customers.push({
      customerId: row.customer_id,
      customerName: row.customer_name,
      status: row.status,
      approvedAt: row.approved_at,
    });
  }

  return [...map.values()];
}

// ---------------------------------------------------------------------------
// Get a single staged payload by ID (metadata + customers, no decryption)
// ---------------------------------------------------------------------------

export async function getStagedPayloadById(
  pool: Pool,
  payloadId: string,
): Promise<StagedEventSummary | null> {
  const rows = await query<{
    payload_id: string;
    aice_id: string;
    event_count: number;
    schema_version: string;
    created_at: Date;
    expires_at: Date;
    customer_id: string;
    customer_name: string;
    status: StagedEventCustomerStatus;
    approved_at: Date | null;
  }>(
    pool,
    `SELECT p.id AS payload_id,
            p.aice_id,
            p.event_count,
            p.schema_version,
            p.created_at,
            p.expires_at,
            sec.customer_id,
            c.name AS customer_name,
            sec.status,
            sec.approved_at
     FROM staged_event_payloads p
     JOIN staged_event_customers sec ON sec.payload_id = p.id
     JOIN customers c ON c.id = sec.customer_id
     WHERE p.id = $1
     ORDER BY c.name`,
    [payloadId],
  );

  if (rows.length === 0) return null;

  const first = rows[0];
  return {
    payloadId: first.payload_id,
    aiceId: first.aice_id,
    eventCount: first.event_count,
    schemaVersion: first.schema_version,
    createdAt: first.created_at,
    expiresAt: first.expires_at,
    customers: rows.map((r) => ({
      customerId: r.customer_id,
      customerName: r.customer_name,
      status: r.status,
      approvedAt: r.approved_at,
    })),
  };
}

// ---------------------------------------------------------------------------
// Decrypt a staged payload
// ---------------------------------------------------------------------------

export async function getStagedPayloadDecrypted(
  pool: Pool,
  payloadId: string,
): Promise<{ payload: Buffer; payloadHash: string } | null> {
  const rows = await query<{
    payload: Buffer;
    wrapped_dek: string;
    payload_hash: string;
  }>(
    pool,
    `SELECT payload, wrapped_dek, payload_hash
     FROM staged_event_payloads WHERE id = $1`,
    [payloadId],
  );

  if (rows.length === 0) return null;

  const { payload: ciphertext, wrapped_dek, payload_hash } = rows[0];
  const plaintext = await decryptPayload(ciphertext, wrapped_dek);
  return { payload: plaintext, payloadHash: payload_hash };
}

// ---------------------------------------------------------------------------
// Update per-customer status (approve / reject)
// ---------------------------------------------------------------------------

export async function updateCustomerStatus(
  client: PoolClient,
  payloadId: string,
  customerId: string,
  action: "approve" | "reject",
): Promise<{ updated: boolean; newStatus: string }> {
  const newStatus = action === "approve" ? "approved" : "rejected";
  const result = await client.query<{ status: string }>(
    `UPDATE staged_event_customers
     SET status = $3,
         approved_at = CASE WHEN $3 = 'approved' THEN NOW() ELSE approved_at END
     WHERE payload_id = $1
       AND customer_id = $2
       AND status = 'pending'
     RETURNING status`,
    [payloadId, customerId, newStatus],
  );

  if (result.rows.length === 0) {
    return { updated: false, newStatus: "unchanged" };
  }

  // If all customers for this payload are now terminal, delete the payload
  const pending = await client.query(
    `SELECT 1 FROM staged_event_customers
     WHERE payload_id = $1 AND status = 'pending' LIMIT 1`,
    [payloadId],
  );
  if (pending.rows.length === 0) {
    await client.query(`DELETE FROM staged_event_payloads WHERE id = $1`, [
      payloadId,
    ]);
  }

  return { updated: true, newStatus: result.rows[0].status };
}

// ---------------------------------------------------------------------------
// Expire pending customers on expired payloads
// ---------------------------------------------------------------------------

export async function expireStagedEvents(pool: Pool): Promise<number> {
  const result = await pool.query(
    `UPDATE staged_event_customers
     SET status = 'expired'
     FROM staged_event_payloads
     WHERE staged_event_customers.payload_id = staged_event_payloads.id
       AND staged_event_payloads.expires_at <= NOW()
       AND staged_event_customers.status = 'pending'`,
  );
  return result.rowCount ?? 0;
}

// ---------------------------------------------------------------------------
// Cleanup fully-resolved payloads
// ---------------------------------------------------------------------------

export async function cleanupTerminalPayloads(pool: Pool): Promise<number> {
  const result = await pool.query(
    `DELETE FROM staged_event_payloads
     WHERE id IN (
       SELECT p.id
       FROM staged_event_payloads p
       WHERE NOT EXISTS (
         SELECT 1 FROM staged_event_customers c
         WHERE c.payload_id = p.id AND c.status = 'pending'
       )
       AND EXISTS (
         SELECT 1 FROM staged_event_customers c2
         WHERE c2.payload_id = p.id
       )
     )`,
  );
  return result.rowCount ?? 0;
}

// ---------------------------------------------------------------------------
// Stage events for manual upload (no bridge connection)
// ---------------------------------------------------------------------------

export async function stageManualUpload(
  pool: Pool,
  params: {
    sessionId: string;
    aiceId: string;
    payloadHash: string;
    ciphertext: Buffer;
    wrappedDek: string;
    eventCount: number;
    schemaVersion: string;
    customerIds: string[];
    ttlSeconds?: number;
  },
): Promise<string> {
  const ttl = params.ttlSeconds ?? 86400; // 24 hours default for manual uploads
  return withTransaction(pool, async (client) => {
    const result = await client.query<{ id: string }>(
      `INSERT INTO staged_event_payloads
         (session_id, aice_id, payload_hash, payload, wrapped_dek, event_count, schema_version, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW() + INTERVAL '1 second' * $8)
       RETURNING id`,
      [
        params.sessionId,
        params.aiceId,
        params.payloadHash,
        params.ciphertext,
        params.wrappedDek,
        params.eventCount,
        params.schemaVersion,
        ttl,
      ],
    );
    const payloadId = result.rows[0].id;

    for (const custId of params.customerIds) {
      await client.query(
        `INSERT INTO staged_event_customers (payload_id, customer_id, status)
         VALUES ($1, $2, 'pending')
         ON CONFLICT (payload_id, customer_id) DO NOTHING`,
        [payloadId, custId],
      );
    }

    return payloadId;
  });
}
