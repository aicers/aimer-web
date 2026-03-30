import "server-only";

import { Pool } from "pg";
import { deleteTransitKey, getTransitConfig } from "../crypto/transit";
import {
  customerDbName,
  customerTransitKeyName,
  getAdminUrl,
} from "../db/customer-db";
import { HttpError } from "./errors";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Injectable dependencies for testing. */
export interface DeleteDeps {
  adminUrl: string;
  skipTransit?: boolean;
  skipAuditAnonymize?: boolean;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Hard-delete a customer and all associated resources.
 *
 * Auth DB operations (steps 1-3) run in a single transaction.
 * Infrastructure cleanup (steps 4-6) runs after the transaction commits
 * and is best-effort — failures are logged but do not rollback the
 * auth_db deletion.
 */
export async function deleteCustomer(
  authPool: Pool,
  auditOwnerPool: Pool,
  customerId: string,
  deps?: DeleteDeps,
): Promise<void> {
  // -----------------------------------------------------------------------
  // Phase 1: Auth DB cleanup (transactional)
  // -----------------------------------------------------------------------
  const client = await authPool.connect();
  try {
    await client.query("BEGIN");

    // Step 1: Delete staged_event_customers for this customer (no CASCADE)
    await client.query(
      "DELETE FROM staged_event_customers WHERE customer_id = $1",
      [customerId],
    );

    // Step 2: Clean up orphaned staged_event_payloads.
    // A payload is orphaned when all its customer rows have been removed
    // or every remaining row has reached terminal state
    // (approved / rejected / expired).
    await client.query(
      `DELETE FROM staged_event_payloads
       WHERE NOT EXISTS (
         SELECT 1 FROM staged_event_customers
         WHERE staged_event_customers.payload_id = staged_event_payloads.id
           AND staged_event_customers.status = 'pending'
       )`,
    );

    // Step 3: Delete customer row (cascades memberships, assignments,
    // environment links, invitations)
    const result = await client.query(
      "DELETE FROM customers WHERE id = $1 RETURNING id",
      [customerId],
    );
    if (result.rows.length === 0) {
      await client.query("ROLLBACK");
      throw new HttpError("Customer not found", 404);
    }

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  // -----------------------------------------------------------------------
  // Phase 2: Infrastructure cleanup (best-effort, post-commit)
  // -----------------------------------------------------------------------

  // Step 4: DROP DATABASE
  const dbName = customerDbName(customerId);
  const adminUrl = deps?.adminUrl ?? getAdminUrl();
  const adminPool = new Pool({ connectionString: adminUrl });
  try {
    // Terminate active connections before dropping
    await adminPool.query(
      `SELECT pg_terminate_backend(pid)
       FROM pg_stat_activity
       WHERE datname = '${dbName}' AND pid <> pg_backend_pid()`,
    );
    await adminPool.query(`DROP DATABASE IF EXISTS ${dbName}`);
  } catch (err) {
    console.error(`Failed to drop database ${dbName}:`, (err as Error).message);
  } finally {
    await adminPool.end();
  }

  // Step 5: Destroy Transit key (crypto-shredding)
  if (!deps?.skipTransit) {
    try {
      const transitConfig = getTransitConfig();
      const keyName = customerTransitKeyName(customerId);
      await deleteTransitKey(transitConfig, keyName);
    } catch (err) {
      console.error(
        `Failed to delete Transit key for customer ${customerId}:`,
        (err as Error).message,
      );
    }
  }

  // Step 6: Anonymize audit log entries (self-audited)
  if (!deps?.skipAuditAnonymize) {
    try {
      const { anonymizeCustomerAuditLogs } = await import("../audit/anonymize");
      await anonymizeCustomerAuditLogs(auditOwnerPool, customerId);
    } catch (err) {
      console.error(
        `Failed to anonymize audit logs for customer ${customerId}:`,
        (err as Error).message,
      );
    }
  }
}
