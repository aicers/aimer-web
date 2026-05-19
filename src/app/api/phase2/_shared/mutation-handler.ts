import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import type { Pool } from "pg";
import type { z } from "zod";
import { type AuditAction, auditLog, UNKNOWN_ACTOR_ID } from "@/lib/audit";
import { withCorrelationId } from "@/lib/audit/correlation";
import {
  EnvelopeVerificationError,
  type VerifiedPhase2Envelope,
  verifyPhase2Multipart,
} from "@/lib/auth/envelope-verify";
import { getAuthPool } from "@/lib/db/client";
import { getCustomerRuntimePool } from "@/lib/db/customer-runtime-pool";
import {
  mapEnvelopeErrorToPhase2Response,
  phase2ErrorResponse,
  zodErrorResponse,
} from "./error-mapping";
import { consumePhase2Jti } from "./jti-replay";

/** Success-action names for the three Phase 2 mutation endpoints. */
export type MutationSuccessAction =
  | "phase2.withdraw"
  | "phase2.refresh_window"
  | "phase2.backfill";

interface MutationConfig<TSchema extends z.ZodTypeAny> {
  /** Expected `schema_version` claim in the envelope. */
  expectedSchemaVersion: string;
  /** Zod schema for the `events_data` payload. */
  payloadSchema: TSchema;
  /** Target type for audit rows. */
  auditTargetType: string;
  /** Success-path audit action name. */
  successAction: MutationSuccessAction;
  /**
   * Execute the mutation in a single per-customer transaction (callers
   * MUST open the transaction inside this function — see the issue's
   * "Do NOT reuse ingestBaselineBatch..." note).
   *
   * Returns the JSON response body (excluding `received_at` /
   * `context_jti`, which this handler appends) and the per-action
   * `details` JSONB to attach to the audit row.
   */
  mutate: (
    customerPool: Pool,
    verified: VerifiedPhase2Envelope,
    payload: z.infer<TSchema>,
  ) => Promise<{
    responseBody: Record<string, unknown>;
    auditDetails: Record<string, unknown>;
  }>;
}

/** Override the auth pool / customer-pool resolver for tests. */
export interface Phase2MutationHandlerDeps {
  getAuthPool?: () => Pool;
  getCustomerRuntimePool?: (customerId: string) => Pool;
}

/**
 * Shared request handler for the three Phase 2 mutation endpoints
 * (`withdraw`, `refresh-window`, `backfill`).
 *
 * Structurally identical to {@link createPhase2BatchHandler} — verify
 * envelope → schema-version match → JSON+Zod parse → consume jti →
 * per-customer transactional work → audit on success only — but
 * carries a different success-response shape (per-route) and a
 * different success-action name.
 */
export function createPhase2MutationHandler<TSchema extends z.ZodTypeAny>(
  config: MutationConfig<TSchema>,
  deps: Phase2MutationHandlerDeps = {},
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
          const claims = err.contextClaims;
          void auditLog({
            actorId: claims?.sub ?? UNKNOWN_ACTOR_ID,
            action: "phase2.verification_failed" satisfies AuditAction,
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

      // JTI replay consumption MUST happen before any DB-mutating step
      // and (for refresh/backfill) before the per-window advisory lock
      // is acquired — a replay must not stall an unrelated concurrent
      // refresh of the same window. RFC 0002 §4.
      const consumeResult = await consumePhase2Jti(authPool, contextClaims.jti);
      if (consumeResult === "replay") {
        return phase2ErrorResponse(
          409,
          "context_jti_replay",
          "context token already used",
          { jti: contextClaims.jti },
        );
      }

      const customerPool = resolveCustomerPool(customerId);
      let result: {
        responseBody: Record<string, unknown>;
        auditDetails: Record<string, unknown>;
      };
      try {
        result = await config.mutate(
          customerPool,
          verified,
          validation.data as z.infer<TSchema>,
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        void auditLog({
          actorId: contextClaims.sub,
          action: "phase2.ingest_failed" satisfies AuditAction,
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
          "mutation failed while writing to the customer database",
        );
      }

      const receivedAt = new Date().toISOString();

      void auditLog({
        actorId: contextClaims.sub,
        action: config.successAction,
        targetType: config.auditTargetType,
        details: {
          schemaVersion: envelopeClaims.schemaVersion,
          ...result.auditDetails,
        },
        customerId,
        aiceId: envelopeClaims.aiceId,
        correlationId: contextClaims.jti,
      });

      return NextResponse.json(
        {
          ...result.responseBody,
          received_at: receivedAt,
          context_jti: contextClaims.jti,
        },
        { status: 200 },
      );
    });
}
