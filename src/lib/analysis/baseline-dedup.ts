// ---------------------------------------------------------------------------
// Canonical `baseline_event` dedup CTE (RFC 0002 round-14 item 2).
//
// Extracted from `report-input-builder.ts` so cost-relevant readers (the
// group cost preview, #511) reuse the SAME dedup SQL the report input builder
// runs, rather than re-deriving it. This module carries no `server-only`
// import so it can be shared by any server module without dragging in the
// whole builder.
// ---------------------------------------------------------------------------

/**
 * Dedupe `baseline_event` to one canonical row per (source_aice_id,
 * event_key) — latest received baseline wins — BEFORE any window predicate.
 * Shared verbatim by every window aggregate so the window test always runs
 * against the canonical row's `event_time`: filtering inside the dedupe could
 * pick an older in-window duplicate even when the canonical latest row is
 * out-of-window.
 */
export const LATEST_BASELINE_CTE = `WITH latest_baseline AS (
       SELECT DISTINCT ON (source_aice_id, event_key)
              source_aice_id, event_key, event_time, category, primary_asset
         FROM baseline_event
        ORDER BY source_aice_id, event_key, received_at DESC, baseline_version DESC
     )`;
