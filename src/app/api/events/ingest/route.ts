import { createHash } from "node:crypto";
import type { NextRequest } from "next/server";
import { auditLog } from "@/lib/auth/audit-stub";
import { verifyCsrf, verifyOrigin, withAuth } from "@/lib/auth/guards";
import { stageManualUpload } from "@/lib/auth/staged-events";
import { encryptPayload } from "@/lib/crypto/envelope";
import { getAuthPool } from "@/lib/db/client";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const DEFAULT_MAX_PAYLOAD_BYTES = 50 * 1024 * 1024; // 50 MB

function getMaxPayloadBytes(): number {
  const envVal = process.env.BRIDGE_MAX_PAYLOAD_BYTES;
  if (envVal) {
    const parsed = Number(envVal);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return DEFAULT_MAX_PAYLOAD_BYTES;
}

export const POST = withAuth(async (req: NextRequest, auth) => {
  const originErr = verifyOrigin(req);
  if (originErr) return originErr;

  const csrfErr = verifyCsrf(req, {
    ctx: "general",
    sid: auth.sessionId,
    iat: auth.iat,
  });
  if (csrfErr) return csrfErr;

  let formData: FormData;
  try {
    formData = await req.formData();
  } catch {
    return Response.json(
      { error: "Invalid multipart form data" },
      { status: 400 },
    );
  }

  // Extract required fields
  const eventsDataField = formData.get("events_data");
  const customerIdField = formData.get("customer_id");
  const aiceIdField = formData.get("aice_id");
  const schemaVersionField = formData.get("schema_version");
  const eventCountField = formData.get("event_count");

  if (!(eventsDataField instanceof File)) {
    return Response.json(
      { error: "Missing events_data file" },
      { status: 400 },
    );
  }
  if (typeof customerIdField !== "string" || !UUID_RE.test(customerIdField)) {
    return Response.json(
      { error: "Missing or invalid customer_id" },
      { status: 400 },
    );
  }
  if (typeof aiceIdField !== "string" || !aiceIdField) {
    return Response.json({ error: "Missing aice_id" }, { status: 400 });
  }
  if (typeof schemaVersionField !== "string" || !schemaVersionField) {
    return Response.json({ error: "Missing schema_version" }, { status: 400 });
  }

  const eventCount = Number(eventCountField);
  if (!Number.isFinite(eventCount) || eventCount < 1) {
    return Response.json(
      { error: "Missing or invalid event_count" },
      { status: 400 },
    );
  }

  // Size check
  const eventsDataBytes = new Uint8Array(await eventsDataField.arrayBuffer());
  const maxBytes = getMaxPayloadBytes();
  if (eventsDataBytes.byteLength > maxBytes) {
    return Response.json(
      { error: `Payload exceeds size cap (${maxBytes} bytes)` },
      { status: 413 },
    );
  }

  // Verify caller has access to the customer
  if (auth.bridgeCustomerIds) {
    if (!auth.bridgeCustomerIds.includes(customerIdField)) {
      return Response.json({ error: "Forbidden" }, { status: 403 });
    }
    // Verify aice_id matches bridge scope
    if (auth.bridgeAiceId && auth.bridgeAiceId !== aiceIdField) {
      return Response.json(
        { error: "aice_id does not match bridge scope" },
        { status: 403 },
      );
    }
  } else {
    // Non-bridge session: verify account has access to the customer
    const pool = getAuthPool();
    const accessCheck = await pool.query(
      `SELECT 1 FROM account_customer_memberships
       WHERE account_id = $1 AND customer_id = $2
       UNION ALL
       SELECT 1 FROM analyst_customer_assignments aca
       JOIN accounts a ON a.id = aca.account_id AND a.analyst_eligible = true
       WHERE aca.account_id = $1 AND aca.customer_id = $2
       LIMIT 1`,
      [auth.accountId, customerIdField],
    );
    if (accessCheck.rows.length === 0) {
      return Response.json({ error: "Forbidden" }, { status: 403 });
    }
  }

  const payloadBuffer = Buffer.from(eventsDataBytes);
  const payloadHash = createHash("sha256").update(payloadBuffer).digest("hex");
  const { ciphertext, wrappedDek } = await encryptPayload(payloadBuffer);

  const pool = getAuthPool();
  const payloadId = await stageManualUpload(pool, {
    sessionId: auth.sessionId,
    aiceId: aiceIdField,
    payloadHash,
    ciphertext,
    wrappedDek,
    eventCount,
    schemaVersion: schemaVersionField,
    customerIds: [customerIdField],
  });

  await auditLog({
    actorId: auth.accountId,
    authContext: "general",
    action: "staged_event.manual_upload",
    targetType: "staged_event_payload",
    targetId: payloadId,
    details: {
      customerId: customerIdField,
      aiceId: aiceIdField,
      eventCount,
    },
    ipAddress: auth.meta.ipAddress,
    sid: auth.sessionId,
    customerId: customerIdField,
  });

  return Response.json({ payloadId, eventCount }, { status: 201 });
});
