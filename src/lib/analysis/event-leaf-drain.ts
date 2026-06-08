// Event-leaf drain-completion signal (#470 Scope §6).
//
// Computes the shared `LeafDrainStatus` (see `leaf-drain.ts`) for the
// EVENT side from `event_analysis_result` on the report-builder event-time
// basis — reusing the same `loadUniverse` query the preview and worker
// use, so the signal agrees with what they materialize. It is independent
// of the `event_leaf_backfill_*` run/item tables, so it stays correct
// across multiple runs (a re-run, a partial run, or no run at all): the
// only question it answers is whether each in-scope existing event leaf
// has a non-superseded leaf under the target variant.
//
// #469 calls this alongside #466's story-side signal and refuses/defers a
// report-variant refresh unless BOTH report `drained`.
//
// SERVER-ONLY. Reads the customer DB only.

import "server-only";

import type { Pool } from "pg";
import { getCurrentTimestamp } from "@/lib/instrumentation/time";
import {
  loadUniverse,
  resolveScopeWindow,
  type TargetVariant,
  type UniverseMember,
} from "./event-leaf-backfill";
import type { LeafDrainStatus } from "./leaf-drain";

/** The outstanding / source-unavailable tally over a universe (pure). */
export interface DrainTally {
  universe: number;
  outstanding: number;
  sourceUnavailable: number;
}

/**
 * Tally a loaded universe into the drain categories. Outstanding = no
 * target-variant leaf AND source still present (not-yet-run or failed);
 * `source_unavailable` is excluded from outstanding.
 */
export function tallyDrain(members: UniverseMember[]): DrainTally {
  let outstanding = 0;
  let sourceUnavailable = 0;
  for (const m of members) {
    if (m.alreadyCurrent) continue;
    if (!m.sourcePresent) {
      sourceUnavailable += 1;
      continue;
    }
    outstanding += 1;
  }
  return { universe: members.length, outstanding, sourceUnavailable };
}

export interface EventLeafDrainArgs {
  customerId: string;
  windowDays: number;
  target: TargetVariant;
  /** Injectable clock for deterministic tests. */
  now?: Date;
}

/**
 * Compute the scope-addressable event-leaf drain status. Keep it
 * scope-addressable so #469 can ask "is THIS scope drained?" rather than
 * relying on a global flag.
 */
export async function computeEventLeafDrain(
  customerPool: Pool,
  args: EventLeafDrainArgs,
): Promise<LeafDrainStatus> {
  const now = args.now ?? getCurrentTimestamp();
  const window = resolveScopeWindow(args.windowDays, now);
  const members = await loadUniverse(customerPool, window, args.target);
  const tally = tallyDrain(members);
  return {
    kind: "event",
    scope: {
      customerId: args.customerId,
      lang: args.target.lang,
      modelName: args.target.modelName,
      model: args.target.model,
      windowDays: args.windowDays,
      windowStart: window.windowStart.toISOString(),
      windowEnd: window.windowEnd.toISOString(),
    },
    universe: tally.universe,
    outstanding: tally.outstanding,
    sourceUnavailable: tally.sourceUnavailable,
    drained: tally.outstanding === 0,
  };
}
