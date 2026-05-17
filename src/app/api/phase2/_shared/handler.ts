import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import type { Pool } from "pg";
import type { z } from "zod";
import { auditLog, UNKNOWN_ACTOR_ID } from "@/lib/audit";
import { withCorrelationId } from "@/lib/audit/correlation";
import {
  EnvelopeVerificationError,
  type VerifiedPhase2Envelope,
  verifyPhase2Multipart,
} from "@/lib/auth/envelope-verify";
import { getAuthPool } from "@/lib/db/client";
import { getCustomerRuntimePool } from "./customer-pool";
import {
  mapEnvelopeErrorToPhase2Response,
  phase2ErrorResponse,
  zodErrorResponse,
} from "./error-mapping";
import type { IngestCounts } from "./ingest";
import { consumePhase2Jti } from "./jti-replay";

interface HandlerConfig<TSchema extends z.ZodTypeAny> {
  /** Expected `schema_version` claim in the envelope. */
  expectedSchemaVersion: string;
  /** Zod schema for the `events_data` payload. */
  payloadSchema: TSchema;
  /** Target type for the audit row. */
  auditTargetType: string;
  /**
   * Perform the per-customer ingest in a transaction. Receives the
   * verified envelope and the parsed payload.
   *
   * The returned `details` field is merged into the audit row's
   * `details` JSONB column alongside the standard fields.
   */
  ingest: (
    customerPool: Pool,
    verified: VerifiedPhase2Envelope,
    payload: z.infer<TSchema>,
  ) => Promise<{
    counts: IngestCounts;
    details?: Record<string, unknown>;
  }>;
}

/** Override the auth pool / customer-pool resolver for tests. */
export interface Phase2HandlerDeps {
  getAuthPool?: () => Pool;
  getCustomerRuntimePool?: (customerId: string) => Pool;
}

/**
 * Shared request handler for the three Phase 2 batch ingest endpoints.
 *
 * Flow:
 *   1. `verifyPhase2Multipart` — multipart parse, JWS signature/freshness,
 *      payload_hash, external_key scope check, customer DB resolution.
 *   2. Schema-version match.
 *   3. JSON parse + Zod validation of the payload body.
 *   4. jti replay consumption (auth-DB `phase2_consumed_jtis` insert).
 *   5. Per-customer transactional INSERT with idempotent ON CONFLICT.
 *   6. `phase2.ingest` audit row (success only).
 */
export function createPhase2BatchHandler<TSchema extends z.ZodTypeAny>(
  config: HandlerConfig<TSchema>,
  deps: Phase2HandlerDeps = {},
): (request: NextRequest) => Promise<NextResponse> {
  const resolveAuthPool = deps.getAuthPool ?? getAuthPool;
  const resolveCustomerPool =
    deps.getCustomerRuntimePool ?? getCustomerRuntimePool;
  return async (request: NextRequest) =>
    withCorrelationId(async () => {
      const authPool = resolveAuthPool();

      let verified: VerifiedPhase2Envelope;
      try {
        verified = await verifyPhase2Multipart(authPool, request);
      } catch (err) {
        if (err instanceof EnvelopeVerificationError) {
          // Record verification failures so operators see them in the
          // audit stream alongside successful ingests. `contextClaims`
          // is populated when the failure happens *after* context-token
          // verification has already succeeded (envelope rejection,
          // payload scope checks); otherwise we fall back to the
          // unknown actor.
          const claims = err.contextClaims;
          void auditLog({
            actorId: claims?.sub ?? UNKNOWN_ACTOR_ID,
            action: "phase2.verification_failed",
            targetType: config.auditTargetType,
            details: {
              code: err.code,
              schemaVersion: config.expectedSchemaVersion,
              ...(err.details ?? {}),
            },
            ...(claims ? { aiceId: claims.aiceId } : {}),
            ...(claims ? { correlationId: claims.jti } : {}),
          });
          return mapEnvelopeErrorToPhase2Response(err);
        }
        throw err;
      }

      const { contextClaims, envelopeClaims, eventsData, customerId } =
        verified;

      // 2. Schema-version match.
      if (envelopeClaims.schemaVersion !== config.expectedSchemaVersion) {
        return phase2ErrorResponse(
          400,
          "schema_version_mismatch",
          `expected schema_version=${config.expectedSchemaVersion}`,
          {
            expected: config.expectedSchemaVersion,
            received: envelopeClaims.schemaVersion,
          },
        );
      }

      // 3. JSON parse + Zod validation. JSON parse failure cannot happen
      //    here — `enforcePhase2CustomerScope` (inside the verifier)
      //    already parsed eventsData as an object. We re-parse for typed
      //    access; treat any divergence as `payload_schema_invalid`.
      let parsed: unknown;
      try {
        parsed = JSON.parse(new TextDecoder().decode(eventsData));
      } catch {
        return phase2ErrorResponse(
          400,
          "payload_schema_invalid",
          "events_data is not valid JSON",
        );
      }
      const validation = config.payloadSchema.safeParse(parsed);
      if (!validation.success) {
        return zodErrorResponse(validation.error);
      }

      // 4. JTI replay consumption — must run BEFORE any per-customer
      //    side-effects. RFC 0002 §4: `409 / context_jti_replay`.
      const consumeResult = await consumePhase2Jti(authPool, contextClaims.jti);
      if (consumeResult === "replay") {
        return phase2ErrorResponse(
          409,
          "context_jti_replay",
          "context token already used",
          { jti: contextClaims.jti },
        );
      }

      // 5. Per-customer ingest. Database failures (e.g. invalid timestamp
      //    or INET cast that survived Zod, FK violations) are translated
      //    to `500 + database_error` with a `phase2.ingest_failed` audit
      //    row so operators have a route-local record of the failure;
      //    the consumed jti is NOT released, mirroring the at-most-once
      //    semantics of the success path.
      const customerPool = resolveCustomerPool(customerId);
      let counts: IngestCounts;
      let extraDetails: Record<string, unknown> | undefined;
      try {
        const ingestResult = await config.ingest(
          customerPool,
          verified,
          validation.data as z.infer<TSchema>,
        );
        counts = ingestResult.counts;
        extraDetails = ingestResult.details;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        void auditLog({
          actorId: contextClaims.sub,
          action: "phase2.ingest_failed",
          targetType: config.auditTargetType,
          details: {
            schemaVersion: envelopeClaims.schemaVersion,
            eventCountClaim: envelopeClaims.eventCount,
            error: message,
          },
          customerId,
          aiceId: envelopeClaims.aiceId,
          correlationId: contextClaims.jti,
        });
        return phase2ErrorResponse(
          500,
          "database_error",
          "ingest failed while writing to the customer database",
        );
      }

      const receivedAt = new Date().toISOString();

      // 6. Audit (success only — failed ingests do NOT emit phase2.ingest).
      void auditLog({
        actorId: contextClaims.sub,
        action: "phase2.ingest",
        targetType: config.auditTargetType,
        details: {
          schemaVersion: envelopeClaims.schemaVersion,
          accepted: counts.accepted,
          duplicatesSkipped: counts.duplicatesSkipped,
          eventCountClaim: envelopeClaims.eventCount,
          ...(extraDetails ?? {}),
        },
        customerId,
        aiceId: envelopeClaims.aiceId,
        correlationId: contextClaims.jti,
      });

      return NextResponse.json(
        {
          accepted: counts.accepted,
          duplicates_skipped: counts.duplicatesSkipped,
          received_at: receivedAt,
          context_jti: contextClaims.jti,
        },
        { status: 200 },
      );
    });
}
