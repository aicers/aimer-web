import {
  applyWindowReplaceEnvelopeHook,
  applyWindowReplaceStoryHook,
} from "@/lib/analysis/ingest-hooks";
import { getAuthPool } from "@/lib/db/client";
import { createPhase2MutationHandler } from "../_shared/mutation-handler";
import {
  executeWindowReplace,
  windowReplacePayloadSchema,
} from "../_shared/window-replace";

export const POST = createPhase2MutationHandler({
  expectedSchemaVersion: "phase2.refresh_window.v1",
  payloadSchema: windowReplacePayloadSchema,
  auditTargetType: "phase2_refresh_window",
  successAction: "phase2.refresh_window",
  mutate: async (customerPool, verified, payload) => {
    const { counts, extras } = await executeWindowReplace(
      customerPool,
      payload,
      verified.envelopeClaims.aiceId,
    );
    // RFC 0002 Phase 0 (#294) — best-effort analysis state hooks.
    // Failure is logged and swallowed (decision 2).
    //
    // BOTH baseline and story envelopes dirty overlapping
    // `periodic_report_state` rows (round-9 review item 1): a story
    // refresh that mutates the inputs of an already-generated
    // DAILY/WEEKLY/MONTHLY report must flip that periodic row to
    // `dirty` so the next worker tick re-runs it. The previous
    // revision dirtied periodic only on baseline envelopes, so a
    // story-only refresh left a stale periodic report ready/done
    // indefinitely — reconcile's periodic dirty signals are
    // baseline-only and could not recover that case.
    const authPool = getAuthPool();
    await applyWindowReplaceEnvelopeHook(authPool, {
      customerId: verified.customerId,
      from: new Date(payload.window.from),
      to: new Date(payload.window.to),
    });
    if (extras.kind === "story") {
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
