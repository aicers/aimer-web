import type { Pool } from "pg";
import { query } from "../db/client";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ValidatedSession {
  createdAt: number;
  lastActiveAt: number;
  bridgeAiceId: string | null;
  bridgeCustomerIds: string[] | null;
}

export class SessionExpiredError extends Error {
  readonly reason: "idle" | "absolute";

  constructor(reason: "idle" | "absolute") {
    super(`Session expired (${reason})`);
    this.reason = reason;
  }
}

export class SessionRevokedError extends Error {
  constructor() {
    super("Session revoked");
  }
}

// ---------------------------------------------------------------------------
// validateSession — revoked check, timeouts, last_active_at update
// ---------------------------------------------------------------------------

export async function validateSession(
  pool: Pool,
  sid: string,
  ctxPolicy: { idle_timeout_minutes: number; absolute_timeout_minutes: number },
): Promise<ValidatedSession> {
  const rows = await query<{
    revoked: boolean;
    created_at: Date;
    last_active_at: Date;
    bridge_aice_id: string | null;
    bridge_customer_ids: string[] | null;
  }>(
    pool,
    `SELECT revoked, created_at, last_active_at, bridge_aice_id, bridge_customer_ids
     FROM sessions WHERE sid = $1`,
    [sid],
  );

  if (rows.length === 0) {
    throw new SessionExpiredError("absolute");
  }

  const row = rows[0];

  // Revoked check
  if (row.revoked) {
    throw new SessionRevokedError();
  }

  const now = Math.floor(Date.now() / 1000);
  const createdAt = Math.floor(row.created_at.getTime() / 1000);
  const lastActiveAt = Math.floor(row.last_active_at.getTime() / 1000);
  const idleSeconds = ctxPolicy.idle_timeout_minutes * 60;
  const absoluteSeconds = ctxPolicy.absolute_timeout_minutes * 60;

  if (now - lastActiveAt > idleSeconds) {
    throw new SessionExpiredError("idle");
  }
  if (now - createdAt > absoluteSeconds) {
    throw new SessionExpiredError("absolute");
  }

  // Update last_active_at
  await query(
    pool,
    `UPDATE sessions SET last_active_at = NOW() WHERE sid = $1`,
    [sid],
  );

  return {
    createdAt,
    lastActiveAt,
    bridgeAiceId: row.bridge_aice_id,
    bridgeCustomerIds: row.bridge_customer_ids,
  };
}
