import { createHash } from "node:crypto";
import type { NextRequest } from "next/server";
import { auditLog } from "@/lib/audit";
import { authorize } from "@/lib/auth/authorization";
import { verifyCsrf, verifyOrigin, withAuth } from "@/lib/auth/guards";
import { stageManualUpload } from "@/lib/auth/staged-events";
import { encryptPayload } from "@/lib/crypto/envelope";
import { getAuthPool, withTransaction } from "@/lib/db/client";

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
  if (!Number.isInteger(eventCount) || eventCount < 1) {
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

  // Authorize: analyses:create with operationKind 'ingest'
  const pool = getAuthPool();
  const authResult = await withTransaction(pool, (client) =>
    authorize(client, "general", auth.accountId, "analyses:create", {
      customerId: customerIdField,
      aiceId: aiceIdField,
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
    targetType: "staged_event_payload",
    ipAddress: auth.meta.ipAddress,
    sid: auth.sessionId,
    customerId: customerIdField,
  };

  if (!authResult.authorized) {
    if (authResult.reason === "bridge_write_blocked") {
      void auditLog({
        ...auditBase,
        action: "bridge.write_attempt_blocked",
        details: {
          customerId: customerIdField,
          aiceId: aiceIdField,
          operation: "ingest",
        },
      });
    }
    void auditLog({
      ...auditBase,
      action: "detection_events.upload_denied",
      targetId: "",
      details: {
        customerId: customerIdField,
        aiceId: aiceIdField,
        reason: authResult.reason ?? "authorization_failed",
      },
    });
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }

  const payloadBuffer = Buffer.from(eventsDataBytes);
  const payloadHash = createHash("sha256").update(payloadBuffer).digest("hex");

  let ciphertext: Buffer;
  let wrappedDek: string;
  try {
    ({ ciphertext, wrappedDek } = await encryptPayload(payloadBuffer));
  } catch (err) {
    void auditLog({
      ...auditBase,
      action: "detection_events.upload_failed",
      targetId: "",
      details: {
        customerId: customerIdField,
        aiceId: aiceIdField,
        reason: "encryption_error",
        error: err instanceof Error ? err.message : String(err),
      },
    });
    throw err;
  }

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

  void auditLog({
    ...auditBase,
    action: "detection_events.upload_completed",
    targetId: payloadId,
    details: {
      customerId: customerIdField,
      aiceId: aiceIdField,
      eventCount,
    },
  });

  return Response.json({ payloadId, eventCount }, { status: 201 });
});
