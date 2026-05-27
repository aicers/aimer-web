import { applyStoryIngestHook } from "@/lib/analysis/ingest-hooks";
import { getAuthPool } from "@/lib/db/client";
import { loadCustomerRanges } from "@/lib/redaction";
import { createPhase2BatchHandler } from "../../_shared/handler";
import { ingestStoryBatch } from "../../_shared/ingest";
import { storyBatchSchema } from "../../_shared/schemas";

export const POST = createPhase2BatchHandler({
  expectedSchemaVersion: "phase2.story.v1",
  payloadSchema: storyBatchSchema,
  auditTargetType: "phase2_story_batch",
  ingest: async (customerPool, verified, payload) => {
    const authPool = getAuthPool();
    const ranges = await loadCustomerRanges(authPool, verified.customerId);
    const result = await ingestStoryBatch(
      customerPool,
      payload,
      verified.customerId,
      verified.envelopeClaims.aiceId,
      ranges,
    );
    // RFC 0002 Phase 0 (#294) — best-effort hook to mark story analysis
    // state pending/dirty after the customer-DB commit succeeds. Hook
    // failure is logged and swallowed (decision 2); the ingest still
    // returns its normal success response.
    await applyStoryIngestHook(authPool, {
      customerId: verified.customerId,
      arrivals: result.storyArrivals,
    });
    return {
      counts: {
        accepted: result.accepted,
        duplicatesSkipped: result.duplicatesSkipped,
      },
      details: {
        storiesAccepted: result.storiesAccepted,
        storiesDuplicates: result.storiesDuplicates,
        membersAccepted: result.membersAccepted,
        membersDuplicates: result.membersDuplicates,
      },
    };
  },
});
