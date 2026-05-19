// Shared SQL helpers for the (`aice_id`, `event_key`) referent existence
// predicate that anchors `event_redaction_map`. Multiple worker paths need
// to ask "is this map row still referenced by any redacted event in this
// customer DB?" — the retention sweeper's cascade pass (issue #255) and
// the staleness scan that re-redacts on policy-version drift (#253). Both
// must agree on the join shape across the four redacted-referent tables
// and `event_analysis_result`, or one of them will silently miss a
// referent and either drop a still-referenced map row (corruption) or
// keep an orphaned one (leak).
//
// The four redacted-referent tables are the only places a redaction token
// can outlive the map: `detection_events`, `baseline_event`, `story_member`
// (joined through its parent `story` for `(source_aice_id, event_key)`),
// and `policy_event` (joined through its parent `policy_run`). `story`
// and `policy_run` themselves are sweep targets — they carry only
// aggregate JSONB and have no redaction-token columns — so they do not
// participate in this predicate even though they are deleted by the
// sweeper alongside their children.

/**
 * NOT-EXISTS clauses for every table that can keep an
 * `event_redaction_map` row live, joined back to a parametrised map
 * alias. Pass `mapAlias` as the SQL alias of the map row whose
 * `(aice_id, event_key)` should be tested.
 *
 * Returns an array (not a joined string) so callers can splice the
 * clauses into different surrounding shapes — a single `WHERE`
 * predicate for a staleness scan, a `WITH candidates AS (...)` CTE
 * for the retention sweeper.
 */
export function redactionMapReferentNotExistsClauses(
  mapAlias: string,
): string[] {
  return [
    `NOT EXISTS (
       SELECT 1 FROM detection_events
        WHERE aice_id = ${mapAlias}.aice_id
          AND event_key = ${mapAlias}.event_key
     )`,
    `NOT EXISTS (
       SELECT 1 FROM baseline_event
        WHERE source_aice_id = ${mapAlias}.aice_id
          AND event_key = ${mapAlias}.event_key
     )`,
    `NOT EXISTS (
       SELECT 1 FROM story_member sm
         JOIN story s ON s.story_id = sm.story_id
                     AND s.story_version = sm.story_version
        WHERE s.source_aice_id = ${mapAlias}.aice_id
          AND sm.member_event_key = ${mapAlias}.event_key
     )`,
    `NOT EXISTS (
       SELECT 1 FROM policy_event pe
         JOIN policy_run pr ON pr.run_id = pe.run_id
        WHERE pr.source_aice_id = ${mapAlias}.aice_id
          AND pe.event_key = ${mapAlias}.event_key
     )`,
    `NOT EXISTS (
       SELECT 1 FROM event_analysis_result
        WHERE aice_id = ${mapAlias}.aice_id
          AND event_key = ${mapAlias}.event_key
     )`,
  ];
}

/**
 * SQL for the retention sweeper's cascade DELETE pass.
 *
 * The shape is deliberate: a `WITH candidates AS (SELECT ... ORDER BY
 * aice_id, event_key FOR UPDATE OF m)` CTE acquires row locks in
 * `(aice_id, event_key)` order, then `DELETE FROM event_redaction_map
 * USING candidates` removes them. The KEK rotation worker
 * (`rewrapCustomerEvents`) holds locks on the same table in the same
 * PK order, so this pass is deadlock-free against it. A plain
 * `DELETE ... WHERE NOT EXISTS (...)` would not give that ordering
 * guarantee, since the planner is free to visit rows in any order.
 */
export function buildRedactionMapCascadeDelete(): string {
  const clauses = redactionMapReferentNotExistsClauses("m");
  return `WITH candidates AS (
  SELECT aice_id, event_key
    FROM event_redaction_map m
   WHERE ${clauses.join("\n     AND ")}
   ORDER BY aice_id, event_key
   FOR UPDATE OF m
)
DELETE FROM event_redaction_map m
 USING candidates c
 WHERE m.aice_id = c.aice_id AND m.event_key = c.event_key`;
}
