import { applyBaselineIngestHook } from "@/lib/analysis/ingest-hooks";
import { getAuthPool } from "@/lib/db/client";
import { loadCustomerOwnedDomains, loadCustomerRanges } from "@/lib/redaction";
import { createPhase2BatchHandler } from "../../_shared/handler";
import { ingestBaselineBatch } from "../../_shared/ingest";
import { baselineBatchSchema } from "../../_shared/schemas";

export const POST = createPhase2BatchHandler({
  expectedSchemaVersion: "phase2.baseline.v1",
  payloadSchema: baselineBatchSchema,
  auditTargetType: "phase2_baseline_batch",
  ingest: async (customerPool, verified, payload) => {
    const authPool = getAuthPool();
    const ranges = await loadCustomerRanges(authPool, verified.customerId);
    const ownedDomains = await loadCustomerOwnedDomains(
      authPool,
      verified.customerId,
    );
    const result = await ingestBaselineBatch(
      customerPool,
      payload,
      verified.customerId,
      verified.envelopeClaims.aiceId,
      ranges,
      ownedDomains,
    );
    // RFC 0002 Phase 0 (#294) — best-effort hook to mark the customer's
    // LIVE periodic_report_state row ready/dirty and seed individual
    // baseline-event auto-analysis jobs (#493). Failure is logged and
    // swallowed (decision 2).
    await applyBaselineIngestHook(authPool, customerPool, {
      customerId: verified.customerId,
      acceptedEvents: result.acceptedEvents,
    });
    return {
      counts: {
        accepted: result.accepted,
        duplicatesSkipped: result.duplicatesSkipped,
      },
      details: { baselineVersion: payload.baseline_version },
    };
  },
});
