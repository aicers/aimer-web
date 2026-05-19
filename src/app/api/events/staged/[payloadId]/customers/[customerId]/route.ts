import type { NextRequest } from "next/server";
import type { AuditAction } from "@/lib/audit";
import { auditLog } from "@/lib/audit";
import { authorize } from "@/lib/auth/authorization";
import {
  InvalidPhase1PayloadError,
  storeApprovedEvents,
} from "@/lib/auth/event-storage";
import { verifyCsrf, verifyOrigin, withAuth } from "@/lib/auth/guards";
import {
  expireStagedEvents,
  getStagedPayloadDecrypted,
  updateCustomerStatus,
} from "@/lib/auth/staged-events";
import { getAuthPool, withTransaction } from "@/lib/db/client";
import { loadCustomerRanges, RedactionInjectivityError } from "@/lib/redaction";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const PATCH = withAuth(async (req: NextRequest, auth) => {
  const originErr = verifyOrigin(req);
  if (originErr) return originErr;

  const csrfErr = verifyCsrf(req, {
    ctx: "general",
    sid: auth.sessionId,
    iat: auth.iat,
  });
  if (csrfErr) return csrfErr;

  // Extract path params
  const segments = req.nextUrl.pathname.split("/");
  // /api/events/staged/[payloadId]/customers/[customerId]
  const customerIdIdx = segments.length - 1;
  const payloadIdIdx = segments.length - 3;
  const customerId = segments[customerIdIdx];
  const payloadId = segments[payloadIdIdx];

  if (!payloadId || !UUID_RE.test(payloadId)) {
    return Response.json(
      { error: "Invalid payloadId format" },
      { status: 400 },
    );
  }
  if (!customerId || !UUID_RE.test(customerId)) {
    return Response.json(
      { error: "Invalid customerId format" },
      { status: 400 },
    );
  }

  // Parse body
  let body: { action?: string };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (body.action !== "approve" && body.action !== "reject") {
    return Response.json(
      { error: 'action must be "approve" or "reject"' },
      { status: 400 },
    );
  }

  const pool = getAuthPool();

  // Expire stale payloads before checking
  await expireStagedEvents(pool);

  // Verify the payload belongs to the caller's session and is not expired
  const ownership = await pool.query<{
    id: string;
    aice_id: string;
    event_count: number;
    schema_version: string;
    connection_id: string | null;
  }>(
    `SELECT id, aice_id, event_count, schema_version, connection_id
     FROM staged_event_payloads
     WHERE id = $1 AND session_id = $2 AND expires_at > NOW()`,
    [payloadId, auth.sessionId],
  );
  if (ownership.rows.length === 0) {
    void auditLog({
      actorId: auth.accountId,
      authContext: "general",
      action: "detection_events.transfer_not_found" satisfies AuditAction,
      targetType: "staged_event_customer",
      targetId: payloadId,
      ipAddress: auth.meta.ipAddress,
      sid: auth.sessionId,
      customerId,
      details: { customerId, reason: "payload_not_owned" },
    });
    return Response.json({ error: "Not found" }, { status: 404 });
  }

  const staged = ownership.rows[0];

  // Authorize: analyses:create with operationKind 'ingest'
  const authResult = await withTransaction(pool, (client) =>
    authorize(client, "general", auth.accountId, "analyses:create", {
      customerId,
      aiceId: staged.aice_id,
      requiresAiceId: true,
      operationKind: "ingest",
      bridgeScope: auth.bridgeCustomerIds
        ? {
            aiceId: auth.bridgeAiceId ?? "",
            customerIds: auth.bridgeCustomerIds,
          }
        : null,
    }),
  );
  const auditBase = {
    actorId: auth.accountId,
    authContext: "general" as const,
    targetType: "staged_event_customer",
    targetId: payloadId,
    ipAddress: auth.meta.ipAddress,
    sid: auth.sessionId,
    customerId,
  };

  if (!authResult.authorized) {
    if (authResult.reason === "bridge_write_blocked") {
      void auditLog({
        ...auditBase,
        action: "bridge.write_attempt_blocked" satisfies AuditAction,
        details: { customerId, aiceId: staged.aice_id, operation: "approve" },
      });
    }
    void auditLog({
      ...auditBase,
      action: "detection_events.transfer_denied" satisfies AuditAction,
      details: {
        customerId,
        reason: authResult.reason ?? "authorization_failed",
      },
    });
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }

  let eventIds: string[] | undefined;
  let result: { updated: boolean; newStatus: string };

  if (body.action === "approve") {
    // Decrypt BEFORE the transaction — uses pool, not the txn client.
    const decrypted = await getStagedPayloadDecrypted(pool, payloadId);
    if (!decrypted) {
      return Response.json(
        { error: "Staged payload not found" },
        { status: 404 },
      );
    }

    // Load the customer's redaction ranges from auth_db before the
    // approve transaction. The ranges table is rarely written and the
    // read is cheap; pulling it outside the txn keeps the redaction
    // engine input ready for every per-event call without holding the
    // auth_db connection longer than necessary.
    const ranges = await loadCustomerRanges(pool, customerId);

    const source = staged.connection_id ? "bridge" : "manual";

    // A single auth_db transaction claims the pending row with FOR UPDATE,
    // writes to customer_db while holding the lock, then updates the status.
    // This prevents concurrent approve requests from creating duplicate
    // detection events: the second request blocks on FOR UPDATE and finds
    // the row already non-pending when the first transaction commits.
    try {
      result = await withTransaction(pool, async (client) => {
        const claim = await client.query(
          `SELECT 1 FROM staged_event_customers
           WHERE payload_id = $1 AND customer_id = $2 AND status = 'pending'
           FOR UPDATE`,
          [payloadId, customerId],
        );
        if (claim.rows.length === 0) {
          return { updated: false, newStatus: "unchanged" };
        }

        // Store in customer_db while holding the auth_db row lock
        eventIds = await storeApprovedEvents({
          customerId,
          aiceId: staged.aice_id,
          eventCount: staged.event_count,
          schemaVersion: staged.schema_version,
          source,
          connectionId: staged.connection_id,
          ingestedBy: auth.accountId,
          plaintext: decrypted.payload,
          ranges,
        });

        return updateCustomerStatus(client, payloadId, customerId, "approve");
      });
    } catch (err) {
      if (err instanceof RedactionInjectivityError) {
        // Invariant 3 breach — emit the dedicated audit (Discussion #10
        // §4) in addition to the generic transfer_failed row so
        // operators can find the conflict without grepping
        // transfer_failed details.
        void auditLog({
          ...auditBase,
          action: "redaction.injectivity_violation",
          details: {
            customerId,
            aiceId: staged.aice_id,
            eventKey: err.eventKey,
            conflict: {
              value: err.value,
              existingToken: err.existingToken,
              conflictingToken: err.conflictingToken,
              existingKind: err.existingKind,
              conflictingKind: err.conflictingKind,
            },
          },
        });
      }
      const reason =
        err instanceof InvalidPhase1PayloadError
          ? err.reason
          : "redaction_failed";
      void auditLog({
        ...auditBase,
        action: "detection_events.transfer_failed",
        details: {
          customerId,
          reason,
          error: err instanceof Error ? err.message : String(err),
        },
      });
      if (err instanceof InvalidPhase1PayloadError) {
        return Response.json({ error: "Conflict", reason }, { status: 409 });
      }
      throw err;
    }
  } else {
    result = await withTransaction(pool, (client) =>
      updateCustomerStatus(client, payloadId, customerId, "reject"),
    );
  }

  if (!result.updated) {
    return Response.json(
      { error: "No pending approval found" },
      { status: 409 },
    );
  }

  const completedAction: AuditAction =
    body.action === "approve"
      ? "detection_events.transfer_approved"
      : "detection_events.transfer_rejected";
  void auditLog({
    ...auditBase,
    action: completedAction,
    details: { customerId, newStatus: result.newStatus, eventIds },
  });

  return Response.json({ status: result.newStatus, eventIds });
});
