import type { NextRequest } from "next/server";
import { auditLog } from "@/lib/auth/audit-stub";
import { verifyCsrf, verifyOrigin, withAuth } from "@/lib/auth/guards";
import {
  expireStagedEvents,
  updateCustomerStatus,
} from "@/lib/auth/staged-events";
import { getAuthPool, withTransaction } from "@/lib/db/client";

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
  const ownership = await pool.query<{ id: string }>(
    `SELECT id FROM staged_event_payloads
     WHERE id = $1 AND session_id = $2 AND expires_at > NOW()`,
    [payloadId, auth.sessionId],
  );
  if (ownership.rows.length === 0) {
    return Response.json({ error: "Not found" }, { status: 404 });
  }

  // Verify the caller has access to this customer
  if (auth.bridgeCustomerIds) {
    if (!auth.bridgeCustomerIds.includes(customerId)) {
      return Response.json({ error: "Forbidden" }, { status: 403 });
    }
  }

  const result = await withTransaction(pool, (client) =>
    updateCustomerStatus(
      client,
      payloadId,
      customerId,
      body.action as "approve" | "reject",
    ),
  );

  if (!result.updated) {
    return Response.json(
      { error: "No pending approval found" },
      { status: 409 },
    );
  }

  await auditLog({
    actorId: auth.accountId,
    authContext: "general",
    action: `staged_event.${body.action}`,
    targetType: "staged_event_customer",
    targetId: payloadId,
    details: { customerId, newStatus: result.newStatus },
    ipAddress: auth.meta.ipAddress,
    sid: auth.sessionId,
    customerId,
  });

  // TODO(#52): On approve, re-encrypt with customer-specific DEK and
  // store in customer_db. For now, only the status is updated.

  return Response.json({ status: result.newStatus });
});
