import { getAuthPool } from "@/lib/db/client";
import { loadCustomerOwnedDomains, loadCustomerRanges } from "@/lib/redaction";
import { createPhase2BatchHandler } from "../_shared/handler";
import { ingestPolicyRun } from "../_shared/ingest";
import { policyRunSchema } from "../_shared/schemas";

export const POST = createPhase2BatchHandler({
  expectedSchemaVersion: "phase2.policy_run.v1",
  payloadSchema: policyRunSchema,
  auditTargetType: "phase2_policy_run",
  ingest: async (customerPool, verified, payload) => {
    const authPool = getAuthPool();
    const ranges = await loadCustomerRanges(authPool, verified.customerId);
    const ownedDomains = await loadCustomerOwnedDomains(
      authPool,
      verified.customerId,
    );
    const result = await ingestPolicyRun(
      customerPool,
      payload,
      verified.customerId,
      verified.envelopeClaims.aiceId,
      ranges,
      ownedDomains,
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
