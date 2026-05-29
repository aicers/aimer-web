-- verify-story-event-time.sql
--
-- Option-(a) eventTime verification queries (Q1/Q2) for RFC 0002 #344.
--
-- WHAT THIS MIRRORS
-- -----------------
-- These queries pin themselves to the canonical-member selection in
-- `loadCanonicalMembers` (src/lib/analysis/story-worker.ts:583). They
-- reproduce, at the set level over the whole customer DB, exactly the
-- canonical-version SELECTION and the baseline_event JOIN KEYS/SCOPE the
-- worker resolves per story at runtime:
--
--   * Canonical version: the worker picks one story row per `story_id`
--     with `ORDER BY received_at DESC, story_version DESC LIMIT 1`
--     (story-worker.ts:599-606). The DB-wide faithful form is
--     `DISTINCT ON (story_id) ... ORDER BY story_id, received_at DESC,
--     story_version DESC`. The leading `story_id` is required by
--     PostgreSQL's DISTINCT ON; the `(received_at DESC, story_version
--     DESC)` tail is the #343 tie-break (efd5cbe) — NOT a bare
--     `received_at DESC`. Resolving a different canonical version here
--     than the worker sends would silently invalidate the check.
--   * story_member join: on `(story_id, story_version)`, the canonical
--     version only.
--   * baseline_event match: on `(source_aice_id, event_key)`, scoped to
--     the canonical story's `source_aice_id` and matched against the
--     canonical-version member `member_event_key`s — the same join
--     keys/scope as the loader's `latest_baseline` CTE
--     (story-worker.ts:653-659).
--
-- WHAT THIS DOES *NOT* MIRROR
-- ---------------------------
-- Q1/Q2 deliberately do NOT apply the loader's `latest_baseline` dedupe
-- (the per-(source_aice_id, event_key) "latest by received_at"
-- collapse). Neither query resolves an `event_time`; they test raw match
-- cardinality. Q1 counts zero-match members — dedupe cannot turn a zero
-- match into a non-zero one. Q2 *measures* the pre-dedupe over-match that
-- the dedupe exists to collapse; applying the dedupe would force Q2 to 0
-- and defeat its purpose.
--
-- DRIFT CONTROL
-- -------------
-- There is no automated guard keeping this artifact in step with
-- `loadCanonicalMembers`. Drift is caught by human review of the diff:
-- if the loader's canonical selection or baseline join keys/scope change
-- (story-worker.ts:583), update the CTEs below in the same change.
--
-- HOW TO RUN / HOW TO READ
-- ------------------------
-- Run against the seeded customer DB (gauntlet A-1, aimer-web#344):
--
--   psql "$CUSTOMER_DATABASE_URL" -f scripts/verify-story-event-time.sql
--
--   * Q1 (unmatched) is the STOP-CONDITION and MUST report 0. A non-zero
--     count means some canonical-version member has no baseline_event
--     source row at all; option (a) cannot resolve its event_time, so
--     escalate to fallback option (c) per #344.
--   * Q2 (over-matched) is INFORMATIONAL. Each row is a member that
--     matches more than one baseline_event row before dedupe (e.g. a
--     rebaselined event surviving under multiple `baseline_version`s).
--     These are absorbed by the runtime `latest_baseline` dedupe; rows
--     here are expected and not a failure.

-- ---------------------------------------------------------------------------
-- Q1 — unmatched canonical-version members (STOP-CONDITION: must be 0)
-- ---------------------------------------------------------------------------
WITH canonical_story AS (
  SELECT DISTINCT ON (story_id)
         story_id,
         story_version,
         source_aice_id
    FROM story
   ORDER BY story_id, received_at DESC, story_version DESC
),
canonical_member AS (
  SELECT sm.story_id,
         sm.story_version,
         sm.member_event_key,
         cs.source_aice_id
    FROM story_member sm
    JOIN canonical_story cs
      ON cs.story_id      = sm.story_id
     AND cs.story_version = sm.story_version
)
SELECT count(*) AS unmatched_member_count
  FROM canonical_member cm
  LEFT JOIN baseline_event be
    ON be.source_aice_id = cm.source_aice_id
   AND be.event_key      = cm.member_event_key
 WHERE be.event_key IS NULL;

-- ---------------------------------------------------------------------------
-- Q2 — over-matched canonical-version members (INFORMATIONAL: pre-dedupe)
-- ---------------------------------------------------------------------------
WITH canonical_story AS (
  SELECT DISTINCT ON (story_id)
         story_id,
         story_version,
         source_aice_id
    FROM story
   ORDER BY story_id, received_at DESC, story_version DESC
),
canonical_member AS (
  SELECT sm.story_id,
         sm.story_version,
         sm.member_event_key,
         cs.source_aice_id
    FROM story_member sm
    JOIN canonical_story cs
      ON cs.story_id      = sm.story_id
     AND cs.story_version = sm.story_version
)
SELECT cm.story_id,
       cm.story_version,
       cm.member_event_key,
       cm.source_aice_id,
       count(*) AS baseline_match_count
  FROM canonical_member cm
  JOIN baseline_event be
    ON be.source_aice_id = cm.source_aice_id
   AND be.event_key      = cm.member_event_key
 GROUP BY cm.story_id, cm.story_version, cm.member_event_key, cm.source_aice_id
HAVING count(*) > 1
 ORDER BY baseline_match_count DESC, cm.story_id, cm.member_event_key;
