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
    const ranges = await loadCustomerRanges(getAuthPool(), verified.customerId);
    const result = await ingestStoryBatch(
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
        storiesAccepted: result.storiesAccepted,
        storiesDuplicates: result.storiesDuplicates,
        membersAccepted: result.membersAccepted,
        membersDuplicates: result.membersDuplicates,
      },
    };
  },
});
