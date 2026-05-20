import "server-only";

import type { Pool, PoolClient } from "pg";
import { encryptPayload } from "../crypto/envelope";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PARStatus =
  | "pending"
  | "processing"
  | "consumed"
  | "expired"
  | "failed";

export interface PendingAnalysisRequest {
  id: string;
  connectionId: string;
  aiceId: string;
  externalKey: string;
  eventKey: string;
  lang: string;
  modelName: string;
  model: string;
  force: boolean;
  payload: Buffer;
  wrappedDek: string;
  payloadHash: string;
  status: PARStatus;
  createdAt: Date;
  expiresAt: Date;
  consumedAt: Date | null;
  viewUrl: string | null;
  failureCode: string | null;
  failureAt: Date | null;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Matches `pending_connections` TTL — both must expire together. */
const PAR_TTL_SECONDS = 300;

/** Matches `cleanupExpiredConnections`'s 24h grace window. */
const PAR_GRACE_PERIOD_HOURS = 24;

// ---------------------------------------------------------------------------
// Row → object mapper
// ---------------------------------------------------------------------------

interface PARRow {
  id: string;
  connection_id: string;
  aice_id: string;
  external_key: string;
  event_key: string;
  lang: string;
  model_name: string;
  model: string;
  force: boolean;
  payload: Buffer;
  wrapped_dek: string;
  payload_hash: string;
  status: PARStatus;
  created_at: Date;
  expires_at: Date;
  consumed_at: Date | null;
  view_url: string | null;
  failure_code: string | null;
  failure_at: Date | null;
}

function mapRow(row: PARRow): PendingAnalysisRequest {
  return {
    id: row.id,
    connectionId: row.connection_id,
    aiceId: row.aice_id,
    externalKey: row.external_key,
    eventKey: row.event_key,
    lang: row.lang,
    modelName: row.model_name,
    model: row.model,
    force: row.force,
    payload: row.payload,
    wrappedDek: row.wrapped_dek,
    payloadHash: row.payload_hash,
    status: row.status,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    consumedAt: row.consumed_at,
    viewUrl: row.view_url,
    failureCode: row.failure_code,
    failureAt: row.failure_at,
  };
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

export interface CreatePendingAnalysisRequestParams {
  connectionId: string;
  aiceId: string;
  externalKey: string;
  eventKey: string;
  lang: string;
  modelName: string;
  model: string;
  force: boolean;
  payload: Buffer;
  payloadHash: string;
}

/**
 * Encrypt the analyze payload and INSERT a pending_analysis_requests
 * row using an existing transaction client. The caller is expected to
 * have already inserted the parent `pending_connections` row on the
 * same client so both writes succeed or roll back together.
 *
 * `expires_at` mirrors `pending_connections` (5 minutes) so both rows
 * expire on the same cleanup tick.
 */
export async function createPendingAnalysisRequestWithClient(
  client: PoolClient,
  params: CreatePendingAnalysisRequestParams,
): Promise<string> {
  const { ciphertext, wrappedDek } = await encryptPayload(params.payload);
  const rows = await client.query<{ id: string }>(
    `INSERT INTO pending_analysis_requests
       (connection_id, aice_id, external_key, event_key,
        lang, model_name, model, force,
        payload, wrapped_dek, payload_hash,
        expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
             NOW() + INTERVAL '${PAR_TTL_SECONDS} seconds')
     RETURNING id`,
    [
      params.connectionId,
      params.aiceId,
      params.externalKey,
      params.eventKey,
      params.lang,
      params.modelName,
      params.model,
      params.force,
      ciphertext,
      wrappedDek,
      params.payloadHash,
    ],
  );
  return rows.rows[0].id;
}

// ---------------------------------------------------------------------------
// Lookups
// ---------------------------------------------------------------------------

export async function loadPendingAnalysisRequest(
  pool: Pool,
  id: string,
): Promise<PendingAnalysisRequest | null> {
  const result = await pool.query<PARRow>(
    `SELECT id, connection_id, aice_id, external_key, event_key,
            lang, model_name, model, force,
            payload, wrapped_dek, payload_hash,
            status, created_at, expires_at, consumed_at,
            view_url, failure_code, failure_at
     FROM pending_analysis_requests WHERE id = $1`,
    [id],
  );
  if (result.rows.length === 0) return null;
  return mapRow(result.rows[0]);
}

export async function loadPARByConnectionIdWithClient(
  client: PoolClient,
  connectionId: string,
): Promise<{ id: string } | null> {
  const result = await client.query<{ id: string }>(
    `SELECT id FROM pending_analysis_requests WHERE connection_id = $1`,
    [connectionId],
  );
  if (result.rows.length === 0) return null;
  return { id: result.rows[0].id };
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

/**
 * Atomically claim a `pending` row by transitioning it to `processing`.
 * Returns true when the calling request now owns the right to run
 * `runAnalyzeFlow`; returns false when a concurrent `/continue` tick
 * already claimed the row (the second tick must re-read PAR.status and
 * dispatch on the new state without invoking the flow).
 *
 * This is the primary concurrency guard the design assumes — see
 * #272's "PAR status is the primary guard against re-execution" note.
 */
export async function claimPAR(pool: Pool, id: string): Promise<boolean> {
  const result = await pool.query(
    `UPDATE pending_analysis_requests
     SET status = 'processing'
     WHERE id = $1 AND status = 'pending'`,
    [id],
  );
  return (result.rowCount ?? 0) > 0;
}

/**
 * Transition `processing` → `consumed` and store the `view_url`.
 * Returns false when the row was not in `processing` state (e.g. the
 * cleanup sweep flipped it to `expired` while `runAnalyzeFlow` was
 * running). The /continue handler re-reads PAR.status on a failed
 * transition and dispatches on the new state.
 *
 * `pending` is also accepted to preserve back-compat with any code
 * path that did not claim first (no such callers exist today; kept
 * to keep the helper forgiving on partial deployments).
 */
export async function markPARConsumed(
  pool: Pool,
  id: string,
  viewUrl: string,
): Promise<boolean> {
  const result = await pool.query(
    `UPDATE pending_analysis_requests
     SET status = 'consumed', view_url = $2, consumed_at = NOW()
     WHERE id = $1 AND status IN ('pending', 'processing')`,
    [id, viewUrl],
  );
  return (result.rowCount ?? 0) > 0;
}

export async function markPARFailed(
  pool: Pool,
  id: string,
  failureCode: string,
): Promise<boolean> {
  const result = await pool.query(
    `UPDATE pending_analysis_requests
     SET status = 'failed', failure_code = $2, failure_at = NOW()
     WHERE id = $1 AND status IN ('pending', 'processing')`,
    [id, failureCode],
  );
  return (result.rowCount ?? 0) > 0;
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

/**
 * Two-phase cleanup symmetric with `cleanupExpiredConnections`:
 *   1. UPDATE pending rows past `expires_at` → `expired`
 *   2. DELETE rows past the 24h grace window (any terminal status)
 *
 * Run **before** `cleanupExpiredConnections` on the same tick — the
 * FK to `pending_connections(connection_id)` would otherwise reject a
 * parent DELETE whenever a child PAR row still sits in the grace
 * window.
 */
export async function cleanupExpiredAnalyzeRequests(
  pool: Pool,
): Promise<number> {
  await pool.query(
    `UPDATE pending_analysis_requests
     SET status = 'expired'
     WHERE status IN ('pending', 'processing') AND expires_at < NOW()`,
  );
  const result = await pool.query(
    `DELETE FROM pending_analysis_requests
     WHERE expires_at < NOW() - INTERVAL '${PAR_GRACE_PERIOD_HOURS} hours'`,
  );
  return result.rowCount ?? 0;
}
