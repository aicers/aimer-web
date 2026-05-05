import { type NextRequest, NextResponse } from "next/server";
import { auditLog, UNKNOWN_ACTOR_ID } from "@/lib/audit";
import { withCorrelationId } from "@/lib/audit/correlation";
import { createPendingConnection, stageEventsPayload } from "@/lib/auth/bridge";
import { verifyContextToken } from "@/lib/auth/context-token";
import {
  clearInvitationTokenCookie,
  setConnectionIdCookie,
} from "@/lib/auth/cookies";
import { TrustRegistryKeyExpiredError } from "@/lib/auth/errors";
import { verifyEventsEnvelope } from "@/lib/auth/events-envelope";
import { extractRequestMeta } from "@/lib/auth/request-meta";
import { getAuthPool } from "@/lib/db/client";

export async function POST(request: NextRequest): Promise<NextResponse> {
  return withCorrelationId(async () => {
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
      const isExpired = err instanceof TrustRegistryKeyExpiredError;
      void auditLog({
        actorId: UNKNOWN_ACTOR_ID,
        action: "bridge.connection_denied",
        targetType: "bridge",
        details: {
          reason: "context_token_rejected",
          ...(isExpired
            ? {
                innerReason: "trust_registry_key_expired",
                aiceId: err.aiceId,
                issuer: err.issuer,
                kid: err.kid,
                expiresAt: new Date(err.expiresAtMs).toISOString(),
              }
            : {}),
          error: String(err),
        },
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

    // Presence semantics — `FormData.get()` returns `null` for absent fields and
    // `""` for present-but-empty text fields. Truthy-checking would treat an
    // empty string the same as a missing field, which would let
    // `events_data=""` (without `events_envelope`) skip envelope validation
    // and silently succeed via the session-only handoff path.
    if (envelopeField !== null || eventsDataField !== null) {
      if (typeof envelopeField !== "string" || !envelopeField) {
        return NextResponse.json(
          { error: "Missing events_envelope" },
          { status: 400 },
        );
      }
      let eventsDataBytes: Uint8Array;
      if (eventsDataField instanceof File) {
        eventsDataBytes = new Uint8Array(await eventsDataField.arrayBuffer());
      } else if (
        typeof eventsDataField === "string" &&
        eventsDataField.length > 0
      ) {
        eventsDataBytes = new TextEncoder().encode(eventsDataField);
      } else {
        return NextResponse.json(
          { error: "Missing events_data" },
          { status: 400 },
        );
      }

      try {
        envelopeClaims = await verifyEventsEnvelope(
          pool,
          envelopeField,
          eventsDataBytes,
          contextClaims,
        );
      } catch (err) {
        const isExpired = err instanceof TrustRegistryKeyExpiredError;
        void auditLog({
          actorId: contextClaims.sub,
          action: "bridge.connection_denied",
          targetType: "bridge",
          details: {
            reason: "envelope_rejected",
            ...(isExpired
              ? {
                  innerReason: "trust_registry_key_expired",
                  kid: err.kid,
                  expiresAt: new Date(err.expiresAtMs).toISOString(),
                }
              : {}),
            error: String(err),
            jti: contextClaims.jti,
          },
          ipAddress: meta.ipAddress,
          aiceId: contextClaims.aiceId,
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
        void auditLog({
          actorId: contextClaims.sub,
          action: "bridge.connection_denied",
          targetType: "bridge",
          details: { reason: "jti_replay", jti: contextClaims.jti },
          ipAddress: meta.ipAddress,
          aiceId: contextClaims.aiceId,
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

    void auditLog({
      actorId: contextClaims.sub,
      action: "bridge.connection_request",
      targetType: "bridge",
      details: {
        connectionId,
        jti: contextClaims.jti,
        hasEvents: !!envelopeClaims,
      },
      ipAddress: meta.ipAddress,
      aiceId: contextClaims.aiceId,
    });

    // Redirect to general OIDC sign-in (flow=bridge preserves connection_id cookie)
    const origin = request.nextUrl.origin;
    return NextResponse.redirect(
      new URL("/api/auth/sign-in?flow=bridge", origin),
    );
  });
}
