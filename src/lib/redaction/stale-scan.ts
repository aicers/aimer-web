// Shared helper that enumerates the customer-DB tables holding
// redaction-policy-versioned rows and locates rows whose stored policy
// version differs from a given target. Both #252's preview endpoint
// (count-only) and #253's worker (full row fetch) consume the same
// definition so the preview number cannot drift from what the worker
// actually processes.

import type { Pool } from "pg";

/**
 * Tables that hold redacted canonical content with a
 * `redaction_policy_version` column. Order is deliberate — joins
 * resolve `aice_id` per-table via the column or join path the worker
 * uses (per #252):
 *
 *   detection_events       — own `aice_id` column
 *   baseline_event         — own `source_aice_id` column
 *   story_member           — join `story` on `(story_id, story_version)`
 *   policy_event           — join `policy_run` on `run_id`
 *   event_analysis_result  — own `aice_id` column
 */
export const REDACTION_VERSIONED_TABLES = [
  "detection_events",
  "baseline_event",
  "story_member",
  "policy_event",
  "event_analysis_result",
] as const;

export type RedactionVersionedTable =
  (typeof REDACTION_VERSIONED_TABLES)[number];

/**
 * SQL fragment that selects rows of the given table whose stored
 * `redaction_policy_version` does not match the `$1` parameter (the
 * target version). Joins through parent tables for
 * `aice_id` resolution where the table itself does not own the
 * column. Bind `$1` to the target policy version on use.
 *
 * Stale criterion: `redaction_policy_version <> $1`. The schema-level
 * empty-string default for new columns is *not* a valid policy
 * version and will always be stale (the engine version stamped by
 * #251 is non-empty).
 */
export function staleRowsCountSql(table: RedactionVersionedTable): string {
  switch (table) {
    case "detection_events":
      return `SELECT COUNT(*)::bigint AS n
              FROM detection_events
              WHERE redaction_policy_version <> $1`;
    case "baseline_event":
      return `SELECT COUNT(*)::bigint AS n
              FROM baseline_event
              WHERE redaction_policy_version <> $1`;
    case "story_member":
      // Worker resolves aice_id through story.source_aice_id; the
      // join here is purely to mirror that scope. An orphaned
      // story_member with no parent story cannot be re-redacted by
      // the worker, so the preview must not count it either.
      return `SELECT COUNT(*)::bigint AS n
              FROM story_member sm
              JOIN story s ON s.story_id = sm.story_id
                          AND s.story_version = sm.story_version
              WHERE sm.redaction_policy_version <> $1`;
    case "policy_event":
      // Same reasoning — worker resolves aice_id via policy_run.
      return `SELECT COUNT(*)::bigint AS n
              FROM policy_event pe
              JOIN policy_run pr ON pr.run_id = pe.run_id
              WHERE pe.redaction_policy_version <> $1`;
    case "event_analysis_result":
      return `SELECT COUNT(*)::bigint AS n
              FROM event_analysis_result
              WHERE redaction_policy_version <> $1`;
  }
}

/**
 * Total number of stale rows across all 5 tables for the given target
 * policy version. Read-only; never mutates rows.
 */
export async function countStaleRows(
  pool: Pool,
  targetPolicyVersion: string,
): Promise<number> {
  let total = 0;
  for (const table of REDACTION_VERSIONED_TABLES) {
    const { rows } = await pool.query<{ n: string }>(staleRowsCountSql(table), [
      targetPolicyVersion,
    ]);
    // `bigint` arrives as a string; parse and accumulate.
    total += Number.parseInt(rows[0].n, 10);
  }
  return total;
}
