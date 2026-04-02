import type { Pool } from "pg";

// ---------------------------------------------------------------------------
// Post-restore volatile state cleanup
// ---------------------------------------------------------------------------

export interface PostRestoreResult {
  sessionsRevoked: number;
  pendingConnectionsDeleted: number;
  stagedCustomersDeleted: number;
  stagedPayloadsDeleted: number;
}

/**
 * Clean up volatile/ephemeral state after restoring auth_db.
 *
 * Revokes all active sessions and deletes transient data that must not
 * survive a restore (pending bridge connections, staged event data).
 *
 * Runs all statements in a single transaction.
 */
export async function runPostRestoreCleanup(
  authPool: Pool,
): Promise<PostRestoreResult> {
  const client = await authPool.connect();
  try {
    await client.query("BEGIN");

    const sessions = await client.query(
      "UPDATE sessions SET revoked = true WHERE revoked = false",
    );

    // staged_event_customers references staged_event_payloads(id),
    // so delete children first.
    const stagedCustomers = await client.query(
      "DELETE FROM staged_event_customers",
    );
    const stagedPayloads = await client.query(
      "DELETE FROM staged_event_payloads",
    );
    const pending = await client.query("DELETE FROM pending_connections");

    await client.query("COMMIT");

    return {
      sessionsRevoked: sessions.rowCount ?? 0,
      pendingConnectionsDeleted: pending.rowCount ?? 0,
      stagedCustomersDeleted: stagedCustomers.rowCount ?? 0,
      stagedPayloadsDeleted: stagedPayloads.rowCount ?? 0,
    };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
