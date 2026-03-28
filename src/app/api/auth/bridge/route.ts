import { type NextRequest, NextResponse } from "next/server";
import { auditLog } from "@/lib/auth/audit-stub";
import { createPendingConnection, stageEventsPayload } from "@/lib/auth/bridge";
import { verifyContextToken } from "@/lib/auth/context-token";
import {
  clearInvitationTokenCookie,
  setConnectionIdCookie,
} from "@/lib/auth/cookies";
import { verifyEventsEnvelope } from "@/lib/auth/events-envelope";
import { extractRequestMeta } from "@/lib/auth/request-meta";
import { getAuthPool } from "@/lib/db/client";

export async function POST(request: NextRequest): Promise<NextResponse> {
  const pool = getAuthPool();
  const meta = extractRequestMeta(request);

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return NextResponse.json(
      { error: "Invalid multipart form data" },
      { status: 400 },
    );
  }

  // Extract fields
  const contextTokenField = formData.get("context_token");
  if (typeof contextTokenField !== "string" || !contextTokenField) {
    return NextResponse.json(
      { error: "Missing context_token" },
      { status: 400 },
    );
  }

  // Verify context token (cryptographic properties only)
  let contextClaims: Awaited<ReturnType<typeof verifyContextToken>>;
  try {
    contextClaims = await verifyContextToken(pool, contextTokenField);
  } catch (err) {
    await auditLog({
      actorId: "unknown",
      action: "bridge.context_token_rejected",
      targetType: "bridge",
      details: { reason: String(err) },
      ipAddress: meta.ipAddress,
    });
    return NextResponse.json(
      { error: "Invalid context token" },
      { status: 403 },
    );
  }

  // Verify events envelope if present
  const envelopeField = formData.get("events_envelope");
  const eventsDataField = formData.get("events_data");

  let envelopeClaims:
    | Awaited<ReturnType<typeof verifyEventsEnvelope>>
    | undefined;
  let eventsDataBuffer: Buffer | undefined;

  if (envelopeField || eventsDataField) {
    if (typeof envelopeField !== "string" || !envelopeField) {
      return NextResponse.json(
        { error: "Missing events_envelope" },
        { status: 400 },
      );
    }
    if (!(eventsDataField instanceof File)) {
      return NextResponse.json(
        { error: "Missing events_data" },
        { status: 400 },
      );
    }

    const eventsDataBytes = new Uint8Array(await eventsDataField.arrayBuffer());

    try {
      envelopeClaims = await verifyEventsEnvelope(
        pool,
        envelopeField,
        eventsDataBytes,
        contextClaims,
      );
    } catch (err) {
      await auditLog({
        actorId: "unknown",
        action: "bridge.envelope_rejected",
        targetType: "bridge",
        details: { reason: String(err), jti: contextClaims.jti },
        ipAddress: meta.ipAddress,
      });
      return NextResponse.json(
        { error: "Invalid events envelope" },
        { status: 403 },
      );
    }

    eventsDataBuffer = Buffer.from(eventsDataBytes);
  }

  // Create pending connection (jti uniqueness enforced by DB constraint)
  let connectionId: string;
  try {
    connectionId = await createPendingConnection(pool, {
      jti: contextClaims.jti,
      issuer: contextClaims.iss,
      aiceId: contextClaims.aiceId,
      customerIds: contextClaims.customerIds,
      sub: contextClaims.sub,
    });
  } catch (err) {
    // jti uniqueness violation → replay attempt
    if (
      err instanceof Error &&
      err.message.includes("pending_connections_jti_key")
    ) {
      await auditLog({
        actorId: "unknown",
        action: "bridge.jti_replay",
        targetType: "bridge",
        details: { jti: contextClaims.jti },
        ipAddress: meta.ipAddress,
      });
      return NextResponse.json(
        { error: "Context token already used" },
        { status: 409 },
      );
    }
    throw err;
  }

  // Stage events data if present
  if (envelopeClaims && eventsDataBuffer) {
    await stageEventsPayload(pool, {
      connectionId,
      aiceId: envelopeClaims.aiceId,
      payloadHash: envelopeClaims.payloadHash,
      payload: eventsDataBuffer,
      eventCount: envelopeClaims.eventCount,
      schemaVersion: envelopeClaims.schemaVersion,
    });
  }

  // Set connection_id cookie
  await setConnectionIdCookie(connectionId);

  // Bridge entry deletes invitation_token (prevent stale cookie)
  await clearInvitationTokenCookie();

  await auditLog({
    actorId: "unknown",
    action: "bridge.entry",
    targetType: "bridge",
    details: {
      connectionId,
      aiceId: contextClaims.aiceId,
      jti: contextClaims.jti,
      hasEvents: !!envelopeClaims,
    },
    ipAddress: meta.ipAddress,
  });

  // Redirect to general OIDC sign-in (flow=bridge preserves connection_id cookie)
  const origin = request.nextUrl.origin;
  return NextResponse.redirect(
    new URL("/api/auth/sign-in?flow=bridge", origin),
  );
}
