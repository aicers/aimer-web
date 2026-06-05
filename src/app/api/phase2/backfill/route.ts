import {
  applyWindowReplaceEnvelopeHook,
  applyWindowReplaceStoryHook,
} from "@/lib/analysis/ingest-hooks";
import { getAuthPool } from "@/lib/db/client";
import { loadCustomerOwnedDomains, loadCustomerRanges } from "@/lib/redaction";
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
    const authPool = getAuthPool();
    const ranges = await loadCustomerRanges(authPool, verified.customerId);
    const ownedDomains = await loadCustomerOwnedDomains(
      authPool,
      verified.customerId,
    );
    const { counts, extras } = await executeWindowReplace(
      customerPool,
      payload,
      verified.customerId,
      verified.envelopeClaims.aiceId,
      ranges,
      ownedDomains,
    );
    // RFC 0002 Phase 0 (#294) — best-effort analysis state hooks.
    // Backfill applies the same dirty/archive rules as refresh-window
    // (issue #294 scope). Failure is logged and swallowed (decision 2).
    //
    // BOTH baseline and story envelopes dirty overlapping
    // `periodic_report_state` rows (round-9 review item 1): a story
    // backfill that mutates the inputs of an already-generated
    // DAILY/WEEKLY/MONTHLY report must flip that periodic row to
    // `dirty`. Reconcile's periodic dirty signals are baseline-only,
    // so this is the only path that catches story-only envelopes.
    // Round-19 review item 1: forward pre-mutation source-time-aligned
    // LIVE overlap flags captured inside the customer-DB transaction.
    // The post-commit EXISTS-based LIVE touched checks miss delete-only
    // envelopes that clear the LIVE input; these flags catch exactly
    // that class.
    const priorLiveBaselineOverlap =
      extras.kind === "baseline" ? extras.baseline.liveBaselineDeleted : false;
    const priorLiveStoryOverlap =
      extras.kind === "story" ? extras.story.liveStoryDeleted : false;
    await applyWindowReplaceEnvelopeHook(authPool, customerPool, {
      customerId: verified.customerId,
      from: new Date(payload.window.from),
      to: new Date(payload.window.to),
      priorLiveBaselineOverlap,
      priorLiveStoryOverlap,
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
