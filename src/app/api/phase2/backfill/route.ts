import {
  applyWindowReplaceBaselineHook,
  applyWindowReplaceStoryHook,
} from "@/lib/analysis/ingest-hooks";
import { getAuthPool } from "@/lib/db/client";
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
    const { counts, extras } = await executeWindowReplace(
      customerPool,
      payload,
      verified.envelopeClaims.aiceId,
    );
    // RFC 0002 Phase 0 (#294) — best-effort analysis state hook.
    // Backfill applies the same dirty/archive rules as refresh-window
    // (issue #294 scope). Failure is logged and swallowed (decision 2).
    const authPool = getAuthPool();
    if (extras.kind === "baseline") {
      await applyWindowReplaceBaselineHook(authPool, {
        customerId: verified.customerId,
        from: extras.baseline.from,
        to: extras.baseline.to,
      });
    } else {
      await applyWindowReplaceStoryHook(authPool, {
        customerId: verified.customerId,
        mutatedStoryIds: extras.story.mutatedStoryIds,
        storyVersionSurvivors: extras.story.storyVersionSurvivors,
      });
    }
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
