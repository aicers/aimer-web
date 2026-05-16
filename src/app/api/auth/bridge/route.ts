import { type NextRequest, NextResponse } from "next/server";
import { auditLog, UNKNOWN_ACTOR_ID } from "@/lib/audit";
import { withCorrelationId } from "@/lib/audit/correlation";
import { createPendingConnection, stageEventsPayload } from "@/lib/auth/bridge";
import {
  clearInvitationTokenCookie,
  setConnectionIdCookie,
} from "@/lib/auth/cookies";
import {
  EnvelopeVerificationError,
  verifyMultipartTokens,
} from "@/lib/auth/envelope-verify";
import { extractRequestMeta } from "@/lib/auth/request-meta";
import { getAuthPool } from "@/lib/db/client";

export async function POST(request: NextRequest): Promise<NextResponse> {
  return withCorrelationId(async () => {
    const pool = getAuthPool();
    const meta = extractRequestMeta(request);

    let verified: Awaited<ReturnType<typeof verifyMultipartTokens>>;
    try {
      verified = await verifyMultipartTokens(pool, request);
    } catch (err) {
      if (err instanceof EnvelopeVerificationError) {
        return mapVerificationErrorToPhase1Response(err, meta.ipAddress);
      }
      throw err;
    }

    const { contextClaims, envelopeClaims, eventsData } = verified;

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
    if (envelopeClaims && eventsData) {
      await stageEventsPayload(pool, {
        connectionId,
        aiceId: envelopeClaims.aiceId,
        payloadHash: envelopeClaims.payloadHash,
        payload: Buffer.from(eventsData),
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

/**
 * Map {@link EnvelopeVerificationError} codes back to the Phase 1 HTTP
 * status set and audit reasons. Keeps Phase 1 e2e behavior identical
 * after the verification logic was extracted into the shared helper.
 *
 * Phase 2 routes will define their own mapper that targets the
 * RFC 0002-aligned status set.
 */
function mapVerificationErrorToPhase1Response(
  err: EnvelopeVerificationError,
  ipAddress: string | undefined,
): NextResponse {
  switch (err.code) {
    case "malformed_multipart":
      return NextResponse.json(
        { error: "Invalid multipart form data" },
        { status: 400 },
      );

    case "missing_context_token":
      return NextResponse.json(
        { error: "Missing context_token" },
        { status: 400 },
      );

    case "missing_events_envelope":
      return NextResponse.json(
        { error: "Missing events_envelope" },
        { status: 400 },
      );

    case "missing_events_data":
      return NextResponse.json(
        { error: "Missing events_data" },
        { status: 400 },
      );

    case "invalid_context_token": {
      void auditLog({
        actorId: UNKNOWN_ACTOR_ID,
        action: "bridge.connection_denied",
        targetType: "bridge",
        details: {
          reason: "context_token_rejected",
          error: String(err.cause ?? err),
        },
        ipAddress,
      });
      return NextResponse.json(
        { error: "Invalid context token" },
        { status: 403 },
      );
    }

    // Phase 1 collapses key-expiry under whichever step (context-token vs
    // envelope) surfaced it. The semantic code identifies the failure mode
    // uniformly; the presence of `err.contextClaims` tells us which step ran.
    case "trust_registry_key_expired": {
      const claims = err.contextClaims;
      const details = err.details ?? {};
      const expiresAtMs =
        typeof details.expiresAtMs === "number" ? details.expiresAtMs : 0;
      const expiresAt = new Date(expiresAtMs).toISOString();
      if (!claims) {
        // Surfaced during context-token verification — no verified claims yet.
        void auditLog({
          actorId: UNKNOWN_ACTOR_ID,
          action: "bridge.connection_denied",
          targetType: "bridge",
          details: {
            reason: "context_token_rejected",
            innerReason: "trust_registry_key_expired",
            aiceId: details.aiceId,
            issuer: details.issuer,
            kid: details.kid,
            expiresAt,
            error: String(err.cause ?? err),
          },
          ipAddress,
        });
        return NextResponse.json(
          { error: "Invalid context token" },
          { status: 403 },
        );
      }
      // Surfaced during envelope verification — context token had already
      // succeeded, so the failure is reported as `envelope_rejected`.
      void auditLog({
        actorId: claims.sub,
        action: "bridge.connection_denied",
        targetType: "bridge",
        details: {
          reason: "envelope_rejected",
          innerReason: "trust_registry_key_expired",
          kid: details.kid,
          expiresAt,
          error: String(err.cause ?? err),
          jti: claims.jti,
        },
        ipAddress,
        aiceId: claims.aiceId,
      });
      return NextResponse.json(
        { error: "Invalid events envelope" },
        { status: 403 },
      );
    }

    // Phase 1 collapses oversize and other envelope failures onto the same
    // 403 / envelope_rejected audit row. Phase 2 routes will split out 413.
    case "invalid_events_envelope":
    case "events_data_too_large": {
      const claims = err.contextClaims;
      void auditLog({
        actorId: claims?.sub ?? UNKNOWN_ACTOR_ID,
        action: "bridge.connection_denied",
        targetType: "bridge",
        details: {
          reason: "envelope_rejected",
          error: String(err.cause ?? err),
          ...(claims ? { jti: claims.jti } : {}),
        },
        ipAddress,
        ...(claims ? { aiceId: claims.aiceId } : {}),
      });
      return NextResponse.json(
        { error: "Invalid events envelope" },
        { status: 403 },
      );
    }

    // Phase 2-only codes cannot reach Phase 1 — the bridge route does not
    // invoke `enforcePhase2CustomerScope`. Fall through to a generic 400.
    default:
      return NextResponse.json({ error: err.message }, { status: 400 });
  }
}
