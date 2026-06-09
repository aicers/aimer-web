import "server-only";

import { Pool } from "pg";
import type { ActorContext } from "../audit";
import { auditLog } from "../audit";
import { deleteTransitKey, getTransitConfig } from "../crypto/transit";
import { getAdminUrl } from "./customer-db";
import { groupDbName, groupTransitKeyName } from "./group-db";

// ---------------------------------------------------------------------------
// Group data-DB teardown (#507).
//
// Peer of delete-customer.ts Phase 2. The group's auth-DB rows are removed
// by #506's deleteGroup() inside the DELETE route's transaction; this runs
// AFTER that transaction commits, as a best-effort post-commit step.
//
// Order matters and mirrors delete-customer exactly:
//   1. terminate connections
//   2. DROP DATABASE (group_<uuid>)
//   3. anonymize related audit logs
//   4. destroy the group Transit key (crypto-shred)
//
// Audit anonymization runs BEFORE DEK destruction so PII is cleaned while
// the data is still readable. A teardown failure never rolls back or
// blocks the entity delete (the group's auth-DB rows are already gone via
// ON DELETE CASCADE from the subject row).
// ---------------------------------------------------------------------------

/** Injectable dependencies for testing. */
export interface TeardownGroupDeps {
  adminUrl: string;
  skipTransit?: boolean;
  skipAuditAnonymize?: boolean;
}

export async function teardownGroupDb(
  auditOwnerPool: Pool,
  groupId: string,
  actorContext?: ActorContext,
  deps?: TeardownGroupDeps,
): Promise<void> {
  // Step 1 + 2: terminate connections, then DROP DATABASE
  const dbName = groupDbName(groupId);
  const adminUrl = deps?.adminUrl ?? getAdminUrl();
  const adminPool = new Pool({ connectionString: adminUrl });
  try {
    const dbExists = await adminPool.query(
      "SELECT 1 FROM pg_database WHERE datname = $1",
      [dbName],
    );
    if (dbExists.rows.length > 0) {
      await adminPool.query(
        `SELECT pg_terminate_backend(pid)
         FROM pg_stat_activity
         WHERE datname = '${dbName}' AND pid <> pg_backend_pid()`,
      );
      await adminPool.query(`DROP DATABASE ${dbName}`);
      if (actorContext) {
        void auditLog({
          actorId: actorContext.actorId,
          authContext: actorContext.authContext,
          action: "group_db.dropped",
          targetType: "group_db",
          targetId: groupId,
          details: { dbName },
          ipAddress: actorContext.ipAddress,
          sid: actorContext.sid,
        });
      }
    }
  } catch (err) {
    console.error(`Failed to drop database ${dbName}:`, (err as Error).message);
  } finally {
    await adminPool.end();
  }

  // Step 3: Anonymize audit log entries (self-audited). Must run before
  // DEK destruction so backup artifacts are cleaned while the data is
  // still accessible.
  if (!deps?.skipAuditAnonymize) {
    try {
      const { anonymizeGroupAuditLogs } = await import("../audit/anonymize");
      await anonymizeGroupAuditLogs(auditOwnerPool, groupId);
    } catch (err) {
      console.error(
        `Failed to anonymize audit logs for group ${groupId}:`,
        (err as Error).message,
      );
    }
  }

  // Step 4: Destroy Transit key (crypto-shredding). After this, any backup
  // artifacts referencing the DEK are unreadable.
  if (!deps?.skipTransit) {
    try {
      const transitConfig = getTransitConfig();
      const keyName = groupTransitKeyName(groupId);
      await deleteTransitKey(transitConfig, keyName);
      if (actorContext) {
        void auditLog({
          actorId: actorContext.actorId,
          authContext: actorContext.authContext,
          action: "openbao.dek_destroyed",
          targetType: "transit_key",
          targetId: keyName,
          details: { groupId },
          ipAddress: actorContext.ipAddress,
          sid: actorContext.sid,
        });
      }
    } catch (err) {
      console.error(
        `Failed to delete Transit key for group ${groupId}:`,
        (err as Error).message,
      );
    }
  }
}
