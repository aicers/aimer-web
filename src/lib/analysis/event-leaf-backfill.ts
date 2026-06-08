// Event-leaf backfill scope + preview computation (#470).
//
// Computes the THREE scope sets the issue pins (Scope §2), all on the SAME
// `baseline_event` event-time basis the report input builder uses
// (`report-input-builder.ts` `selectTopEvents`), so preview, the worker's
// materialized work items, and the drain signal all agree with what the
// report aggregates:
//
//   - Universe          — `(aice_id, event_key)` whose latest baseline_event
//                         event_time falls in the scope window AND which
//                         already have a non-superseded `event_analysis_result`
//                         leaf under SOME model (this backfill re-analyzes
//                         existing leaves, not never-analyzed events).
//   - Work candidates   — universe members with NO non-superseded leaf for
//                         the target `(lang, model_name, model)` variant.
//   - already_current   — universe members that DO have a target-variant
//                         non-superseded leaf: counted in preview, not re-run.
//
// `source_unavailable` is a work candidate whose `detection_events` row was
// swept by retention (the analysis row survives, the redacted source is
// gone): it cannot be re-analyzed here and is excluded from the drain
// outstanding count. Detecting it requires a customer-DB lookup, folded
// into the universe query below as `source_present`.
//
// SERVER-ONLY. Reads the customer DB only.

import "server-only";

import type { Pool } from "pg";
import { getCurrentTimestamp } from "@/lib/instrumentation/time";

/** Default recent-window (days) when the operator gives no time scope. */
export const DEFAULT_WINDOW_DAYS = 7;

/** A resolved scope window on the baseline_event event-time basis. */
export interface ScopeWindow {
  windowStart: Date;
  windowEnd: Date;
}

/** The target variant a backfill run re-analyzes toward. */
export interface TargetVariant {
  lang: string;
  modelName: string;
  model: string;
}

/** One member of the scoped existing event-leaf universe (Scope §2). */
export interface UniverseMember {
  aiceId: string;
  /** Decimal event-key string. */
  eventKey: string;
  /** Latest baseline_event event_time (ISO), used for cap ordering. */
  eventTime: string;
  /** Has a non-superseded leaf for the TARGET variant → counted, not re-run. */
  alreadyCurrent: boolean;
  /** Has a surviving `detection_events` row → re-analyzable (else swept). */
  sourcePresent: boolean;
}

/**
 * Resolve a recent-window scope from `windowDays`. The window ends at the
 * current instant and starts `windowDays` earlier. `now` is injectable for
 * deterministic tests (defaults to the worker time seam).
 */
export function resolveScopeWindow(
  windowDays: number,
  now: Date = getCurrentTimestamp(),
): ScopeWindow {
  const windowEnd = now;
  const windowStart = new Date(
    now.getTime() - windowDays * 24 * 60 * 60 * 1000,
  );
  return { windowStart, windowEnd };
}

/**
 * Load the scoped existing event-leaf universe with the per-member flags
 * the preview / worker / drain all derive from. One customer-DB query on
 * the report-builder event-time basis.
 */
export async function loadUniverse(
  customerPool: Pool,
  window: ScopeWindow,
  target: TargetVariant,
): Promise<UniverseMember[]> {
  const { rows } = await customerPool.query<{
    aice_id: string;
    event_key: string;
    // node-postgres maps `timestamptz` to a JS Date by default; keep the
    // wider type so the ISO coercion below is well-typed.
    event_time: Date | string;
    already_current: boolean;
    source_present: boolean;
  }>(
    // Dedupe baseline_event to one canonical row per (source_aice_id,
    // event_key) FIRST (no window predicate inside the CTE), THEN apply the
    // window predicate to the canonical row's event_time — the SAME order
    // `selectTopEvents` locks, so the universe matches the report's
    // selectable event set for the variant.
    `WITH latest_baseline AS (
       SELECT DISTINCT ON (source_aice_id, event_key)
              source_aice_id AS aice_id, event_key, event_time
         FROM baseline_event
        ORDER BY source_aice_id, event_key, received_at DESC, baseline_version DESC
     ),
     universe AS (
       SELECT DISTINCT e.aice_id, e.event_key, lb.event_time
         FROM event_analysis_result e
         JOIN latest_baseline lb
           ON lb.aice_id = e.aice_id AND lb.event_key = e.event_key
        WHERE e.superseded_at IS NULL
          AND lb.event_time >= $1::timestamptz
          AND lb.event_time <  $2::timestamptz
     )
     SELECT u.aice_id,
            u.event_key::text AS event_key,
            u.event_time,
            EXISTS (
              SELECT 1 FROM event_analysis_result t
               WHERE t.aice_id = u.aice_id AND t.event_key = u.event_key
                 AND t.lang = $3 AND t.model_name = $4 AND t.model = $5
                 AND t.superseded_at IS NULL
            ) AS already_current,
            EXISTS (
              SELECT 1 FROM detection_events d
               WHERE d.aice_id = u.aice_id AND d.event_key = u.event_key
            ) AS source_present
       FROM universe u
      ORDER BY u.event_time DESC, u.aice_id, u.event_key`,
    [
      window.windowStart.toISOString(),
      window.windowEnd.toISOString(),
      target.lang,
      target.modelName,
      target.model,
    ],
  );
  return rows.map((r) => ({
    aiceId: r.aice_id,
    eventKey: r.event_key,
    eventTime:
      r.event_time instanceof Date
        ? r.event_time.toISOString()
        : String(r.event_time),
    alreadyCurrent: r.already_current,
    sourcePresent: r.source_present,
  }));
}

/** The categorized preview counts over the §2 universe (Scope §7 / §8). */
export interface PreviewCounts {
  /** Universe size — every existing in-window leaf, all categories summed. */
  totalUniverse: number;
  /** Work candidates that are re-analyzable AND within the per-run cap. */
  reanalyze: number;
  /** Universe members already on the target variant (counted, not re-run). */
  alreadyCurrent: number;
  /** Work candidates whose redacted source was retention-swept. */
  sourceUnavailable: number;
  /** Re-analyzable work candidates dropped by the per-run cap. */
  capExcluded: number;
}

/**
 * The materialization plan derived from the universe: which events become
 * `pending` work items, and the aggregate counts seeded onto the run row.
 * Only work items the run will actually touch are materialized per-item;
 * `already_current` / `source_unavailable` / `cap_excluded` are aggregate
 * counts (per-item materialization of an unbounded excluded set is the
 * deliberate open choice the issue leaves to aggregate, Mechanism §).
 */
export interface MaterializationPlan {
  counts: PreviewCounts;
  /** Re-analyzable work candidates within the cap, in processing order. */
  workItems: Array<{ aiceId: string; eventKey: string }>;
}

/**
 * Split the universe into the preview/materialization categories under an
 * optional per-run cap. Re-analyzable candidates are kept most-recent-first
 * (the universe is already ordered by event_time DESC), so a cap keeps the
 * freshest events and reports the remainder as `cap_excluded`.
 */
export function planBackfill(
  members: UniverseMember[],
  maxItems: number | null,
): MaterializationPlan {
  let alreadyCurrent = 0;
  let sourceUnavailable = 0;
  const reanalyzable: Array<{ aiceId: string; eventKey: string }> = [];
  for (const m of members) {
    if (m.alreadyCurrent) {
      alreadyCurrent += 1;
    } else if (!m.sourcePresent) {
      sourceUnavailable += 1;
    } else {
      reanalyzable.push({ aiceId: m.aiceId, eventKey: m.eventKey });
    }
  }
  const cap = maxItems != null && maxItems >= 0 ? maxItems : null;
  const workItems = cap == null ? reanalyzable : reanalyzable.slice(0, cap);
  const capExcluded = reanalyzable.length - workItems.length;
  return {
    counts: {
      totalUniverse: members.length,
      reanalyze: workItems.length,
      alreadyCurrent,
      sourceUnavailable,
      capExcluded,
    },
    workItems,
  };
}

/**
 * Compute a preview without materializing — load the universe and split it.
 * The create endpoint shows these counts and requires explicit confirm
 * before the run proceeds (Scope §7).
 */
export async function previewBackfill(
  customerPool: Pool,
  window: ScopeWindow,
  target: TargetVariant,
  maxItems: number | null,
): Promise<PreviewCounts> {
  const members = await loadUniverse(customerPool, window, target);
  return planBackfill(members, maxItems).counts;
}
