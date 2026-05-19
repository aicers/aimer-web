import { getAuthPool } from "@/lib/db/client";
import { loadCustomerRanges } from "@/lib/redaction";
import { createPhase2BatchHandler } from "../_shared/handler";
import { ingestPolicyRun } from "../_shared/ingest";
import { policyRunSchema } from "../_shared/schemas";

export const POST = createPhase2BatchHandler({
  expectedSchemaVersion: "phase2.policy_run.v1",
  payloadSchema: policyRunSchema,
  auditTargetType: "phase2_policy_run",
  ingest: async (customerPool, verified, payload) => {
    const ranges = await loadCustomerRanges(getAuthPool(), verified.customerId);
    const result = await ingestPolicyRun(
      customerPool,
      payload,
      verified.customerId,
      verified.envelopeClaims.aiceId,
      ranges,
    );
    return {
      counts: {
        accepted: result.accepted,
        duplicatesSkipped: result.duplicatesSkipped,
      },
      details: {
        runId: String(payload.run.run_id),
        runStatus: result.runStatus,
      },
    };
  },
});
