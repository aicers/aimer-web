// RFC 0002 Phase 0 (#294) — best-effort auth-DB hooks invoked by the
// Phase 2 route handlers after the customer-DB ingest commits.
//
// Hook failure response policy (issue #294, decision 2): the customer-
// DB commit is the source of truth; auth-DB writes here are best-effort.
// A failure is logged at `error` level and the ingest's normal success
// response is still returned to the sender. The reconcile scan in
// `analysis-reconcile-worker.ts` seeds and forward-patches any missing
// rows on its own cadence (default 15min). Returning 500 after a
// successful customer-DB commit would tell the sender to retry an
// ingest whose JTI is already consumed.

import "server-only";

import type { Pool } from "pg";
import {
  dirtyPeriodicStatesOverlapping,
  dirtyStoryStatesInRange,
  maybeArchiveStoryState,
  recordBaselineActivity,
  recordStoryMemberArrival,
} from "./state";

async function loadCustomerTimezone(
  pool: Pool,
  customerId: string,
): Promise<string | null> {
  const { rows } = await pool.query<{ timezone: string }>(
    "SELECT timezone FROM customers WHERE id = $1",
    [customerId],
  );
  return rows[0]?.timezone ?? null;
}

function logHookFailure(scope: string, customerId: string, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  console.error(
    `[analysis-hook] ${scope} failed for customer ${customerId}: ${message}`,
  );
}

// ---------------------------------------------------------------------------
// Baseline ingest hook
// ---------------------------------------------------------------------------

export interface BaselineIngestHookInput {
  customerId: string;
  /** Last `event_time` accepted in the batch, or null when none. */
  lastEventArrivalAt: Date | null;
}

export async function applyBaselineIngestHook(
  authPool: Pool,
  input: BaselineIngestHookInput,
): Promise<void> {
  if (!input.lastEventArrivalAt) return;
  try {
    const tz = await loadCustomerTimezone(authPool, input.customerId);
    if (!tz) return;
    const client = await authPool.connect();
    try {
      await recordBaselineActivity(
        client,
        input.customerId,
        tz,
        input.lastEventArrivalAt,
      );
    } finally {
      client.release();
    }
  } catch (err) {
    logHookFailure("baseline_ingest", input.customerId, err);
  }
}

// ---------------------------------------------------------------------------
// Story ingest hook
// ---------------------------------------------------------------------------

export interface StoryArrival {
  storyId: string;
  arrivedAt: Date;
}

export interface StoryIngestHookInput {
  customerId: string;
  arrivals: StoryArrival[];
}

export async function applyStoryIngestHook(
  authPool: Pool,
  input: StoryIngestHookInput,
): Promise<void> {
  if (input.arrivals.length === 0) return;
  try {
    const client = await authPool.connect();
    try {
      for (const arrival of input.arrivals) {
        await recordStoryMemberArrival(
          client,
          input.customerId,
          arrival.storyId,
          arrival.arrivedAt,
        );
      }
    } finally {
      client.release();
    }
  } catch (err) {
    logHookFailure("story_ingest", input.customerId, err);
  }
}

// ---------------------------------------------------------------------------
// Window-replace / backfill hooks
// ---------------------------------------------------------------------------

export interface WindowReplaceBaselineHookInput {
  customerId: string;
  from: Date;
  to: Date;
}

export async function applyWindowReplaceBaselineHook(
  authPool: Pool,
  input: WindowReplaceBaselineHookInput,
): Promise<void> {
  try {
    const client = await authPool.connect();
    try {
      await dirtyPeriodicStatesOverlapping(
        client,
        input.customerId,
        input.from,
        input.to,
      );
    } finally {
      client.release();
    }
  } catch (err) {
    logHookFailure("refresh_window_baseline", input.customerId, err);
  }
}

export interface WindowReplaceStoryHookInput {
  customerId: string;
  /** Stories whose member set was mutated by the window replace. */
  mutatedStoryIds: string[];
  /**
   * Survivor counts per `story_id` — `(story_id, surviving)` where
   * `surviving` is the count of `story` rows still present in the
   * customer DB for that `story_id` after the window-replace commits.
   * A count of 0 archives the state row (issue #294 decision 1).
   */
  storyVersionSurvivors: Array<{ storyId: string; surviving: number }>;
}

export async function applyWindowReplaceStoryHook(
  authPool: Pool,
  input: WindowReplaceStoryHookInput,
): Promise<void> {
  try {
    const client = await authPool.connect();
    try {
      // Dirty mutated stories first; then archive any that have no
      // surviving version. Ordering matters because the dirty UPDATE
      // is a no-op on archived rows.
      if (input.mutatedStoryIds.length > 0) {
        await dirtyStoryStatesInRange(
          client,
          input.customerId,
          input.mutatedStoryIds,
        );
      }
      for (const { storyId, surviving } of input.storyVersionSurvivors) {
        await maybeArchiveStoryState(
          client,
          input.customerId,
          storyId,
          surviving,
        );
      }
    } finally {
      client.release();
    }
  } catch (err) {
    logHookFailure("refresh_window_story", input.customerId, err);
  }
}
