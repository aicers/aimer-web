import { createPhase2MutationHandler } from "../_shared/mutation-handler";
import {
  executeWindowReplace,
  windowReplacePayloadSchema,
} from "../_shared/window-replace";

export const POST = createPhase2MutationHandler({
  expectedSchemaVersion: "phase2.backfill.v1",
  payloadSchema: windowReplacePayloadSchema,
  auditTargetType: "phase2_backfill",
  successAction: "phase2.backfill",
  mutate: async (customerPool, verified, payload) => {
    const counts = await executeWindowReplace(
      customerPool,
      payload,
      verified.envelopeClaims.aiceId,
    );
    return {
      responseBody: {
        accepted: counts.accepted,
        duplicates_skipped: 0,
        deleted: counts.deleted,
      },
      auditDetails: {
        window: payload.window,
        accepted: counts.accepted,
        deleted: counts.deleted,
        eventCountClaim: verified.envelopeClaims.eventCount,
      },
    };
  },
});
