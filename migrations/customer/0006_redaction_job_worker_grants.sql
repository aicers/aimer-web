-- Redaction-job-worker runtime grants (issue #253).
--
-- The retroactive re-redact worker connects to customer_db as the
-- restricted `aimer_customer` role (the same role used by Phase 1
-- ingest and the retention sweeper). To re-stamp stale rows with a
-- new `redaction_policy_version` and rewrite their redacted payload,
-- the worker issues UPDATE against four tables it currently has no
-- UPDATE grant on: detection_events, baseline_event, story_member,
-- and policy_event.
--
-- Grants are column-scoped to preserve the restricted-role posture:
-- only the redacted-payload columns and the policy-version column
-- the worker actually writes are exposed. Operator-only columns
-- (PKs, timestamps, FKs, source_aice_id, raw_score, etc.) stay
-- read-only via this role.
--
-- The "no UPDATE on Phase 2" guard in
-- src/lib/db/__tests__/customer-schema.db.test.ts is narrowed by
-- this PR to assert only on columns the worker does not touch;
-- new positive tests assert UPDATE works for the worker's column
-- set on each of the four tables.

GRANT UPDATE (redacted_event, redaction_policy_version)
    ON detection_events TO aimer_customer;

GRANT UPDATE (raw_event, redaction_policy_version)
    ON baseline_event TO aimer_customer;

GRANT UPDATE (event, redaction_policy_version)
    ON story_member TO aimer_customer;

GRANT UPDATE (
    orig_addr,
    resp_addr,
    host,
    dns_query,
    uri,
    policy_triage_snapshot,
    redaction_policy_version
) ON policy_event TO aimer_customer;
