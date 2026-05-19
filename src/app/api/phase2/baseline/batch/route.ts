import { getAuthPool } from "@/lib/db/client";
import { loadCustomerRanges } from "@/lib/redaction";
import { createPhase2BatchHandler } from "../../_shared/handler";
import { ingestBaselineBatch } from "../../_shared/ingest";
import { baselineBatchSchema } from "../../_shared/schemas";

export const POST = createPhase2BatchHandler({
  expectedSchemaVersion: "phase2.baseline.v1",
  payloadSchema: baselineBatchSchema,
  auditTargetType: "phase2_baseline_batch",
  ingest: async (customerPool, verified, payload) => {
    const ranges = await loadCustomerRanges(getAuthPool(), verified.customerId);
    const counts = await ingestBaselineBatch(
      customerPool,
      payload,
      verified.customerId,
      verified.envelopeClaims.aiceId,
      ranges,
    );
    return {
      counts,
      details: { baselineVersion: payload.baseline_version },
    };
  },
});
