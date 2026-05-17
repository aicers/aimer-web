# Phase 2 Ingest

This page is for operators. It describes the three Phase 2 batch
ingest endpoints aimer-web exposes to aice-web-next, the standard
acknowledgement shape, the request-size cap, and the end-to-end
wiring check.

## Endpoints

| Endpoint | Schema version | Body |
| --- | --- | --- |
| `POST /api/phase2/baseline/batch` | `phase2.baseline.v1` | one or more `baseline_event` rows under a single `baseline_version` |
| `POST /api/phase2/story/batch` | `phase2.story.v1` | one or more `story` rows, each with its `story_member` rows |
| `POST /api/phase2/policy-run` | `phase2.policy_run.v1` | exactly one `policy_run` row and its `policy_event` rows |

All three share the same `multipart/form-data` envelope contract
(RFC 0002 §6.1): three parts named `context_token`, `events_envelope`,
`events_data`. aimer-web verifies signatures and freshness via the
shared envelope helper, consumes the context-token `jti` once against
the auth-DB replay store (`phase2_consumed_jtis`), then INSERTs into
the resolved customer database with `ON CONFLICT DO NOTHING` on the
natural key.

## Response shape

Per RFC 0002 §6, every successful call returns the same four fields:

```json
{
  "accepted": 12,
  "duplicates_skipped": 0,
  "received_at": "2026-05-17T10:23:45.012Z",
  "context_jti": "550e8400-e29b-41d4-a716-446655440000"
}
```

- `accepted` counts the rows actually inserted by this call.
- `duplicates_skipped` counts rows skipped via the idempotent natural
  key (`baseline_version, event_key` / `story_id, story_version` /
  `run_id, event_key`).
- `received_at` is aimer-web's wall-clock at the moment the response
  is built.
- `context_jti` echoes the envelope's context-token jti so
  aice-web-next can ack-match its outbox row.

For `phase2.story.v1`, `accepted` / `duplicates_skipped` count
**stories**, not their members. Member-level counts are recorded in
the `phase2.ingest` audit row's `details` JSONB for observability.

For `phase2.policy_run.v1`, `accepted` / `duplicates_skipped` count
**policy_event** rows; the run row's new-vs-duplicate status is in
the audit `details.runStatus`. Multi-batch arrival for the same
`run_id` converges to the same end state because the
`(run_id, event_key)` constraint is enforced row-by-row.

## Error responses

The route maps the shared envelope helper's semantic codes to the
RFC 0002 §6 HTTP status set:

| HTTP | `code` | When |
| --- | --- | --- |
| 400 | `malformed_multipart` | form parse failed |
| 400 | `missing_context_token` | part absent or empty |
| 400 | `missing_events_envelope` | part absent or empty |
| 400 | `missing_events_data` | part absent or empty |
| 400 | `malformed_payload` | `events_data` not a JSON object |
| 400 | `missing_external_key` | payload root missing `external_key` |
| 400 | `schema_version_mismatch` | envelope's `schema_version` ≠ endpoint's |
| 400 | `payload_schema_invalid` | Zod validation failed |
| 401 | `invalid_context_token` | signature / freshness / claims invalid |
| 401 | `invalid_events_envelope` | signature / payload_hash / claims invalid |
| 401 | `trust_registry_key_expired` | key past `expires_at` |
| 403 | `payload_customer_not_authorized` | `external_key` not in context token scope |
| 403 | `envelope_payload_aice_id_mismatch` | `events_data.source_aice_id` ≠ envelope `aice_id` |
| 404 | `customer_not_found` | `external_key` does not resolve to a customer row |
| 409 | `context_jti_replay` | same `jti` already consumed |
| 413 | `events_data_too_large` | payload exceeds `BRIDGE_MAX_PAYLOAD_BYTES` |

All non-5xx errors surface immediately to the user as 4xx without
retry from aice-web-next's perspective.

## Request size cap

The envelope verifier enforces `BRIDGE_MAX_PAYLOAD_BYTES` against the
`events_data` byte length **before** any crypto. The default is
50 MiB; override with the environment variable.

The cap must be reconciled across both repos:

- aimer-web reads `BRIDGE_MAX_PAYLOAD_BYTES` at request time.
- aice-web-next must split oversize policy-run pushes into multiple
  `phase2.policy_run.v1` batches that share the same `run_id`
  (RFC 0002 §6).

If you raise the cap on aimer-web, also raise the corresponding
producer-side limit on aice-web-next; if you lower it, the sender's
splitter must follow or batches will start returning 413.

## End-to-end wiring check

Use this checklist when bringing up a new customer + AICE pair.

1. **Trust registry**: the AICE environment's signing key is
   registered in the auth-DB `trust_registry` table and not expired
   (`SELECT kid, expires_at FROM trust_registry WHERE aice_id = …`).
2. **Customer mapping**: the customer's `external_key` in
   `customers.external_key` exactly matches the value
   aice-web-next places in `events_data.external_key`. Mismatch
   surfaces as `404 customer_not_found`.
3. **Customer database**: `customers.database_status = 'active'`.
   A provisioning or failed status means the per-customer DB is not
   ready; the route resolves the pool but INSERTs will fail.
4. **Phase 2 tables**: the customer DB has migration `0002` applied
   (`SELECT version FROM _migrations` in the customer DB). The five
   tables required for ingest are `baseline_event`, `story`,
   `story_member`, `policy_run`, `policy_event`.
5. **JTI replay store**: the auth DB has migration `0018` applied
   and the runtime role can `INSERT` and `DELETE`. Verify with
   `SELECT 1 FROM phase2_consumed_jtis LIMIT 1` as `aimer_auth`.
6. **Send a probe batch** from aice-web-next with one event. A
   successful call returns 200 with `accepted: 1`,
   `duplicates_skipped: 0`. A second call with the same context
   token returns 409 `context_jti_replay`. A third call with a fresh
   context token but the same event key returns 200 with
   `accepted: 0`, `duplicates_skipped: 1`.

## Audit

Every successful ingest emits one `phase2.ingest` row to the audit
DB. Failed ingests do not (envelope / verification failures emit
their own audit per the helper's existing pattern).

Top-level columns:

- `actor_id` — `sub` claim from the verified context token.
- `aice_id` — from the events envelope.
- `customer_id` — the resolved customer UUID.
- `correlation_id` — the context-token `jti`, for cross-repo
  correlation with aice-web-next's outbox.

`details` JSONB carries `schemaVersion`, `accepted`,
`duplicatesSkipped`, `eventCountClaim` (from the envelope), and
endpoint-specific fields:

- baseline: `baselineVersion`.
- story: `storiesAccepted`, `storiesDuplicates`,
  `membersAccepted`, `membersDuplicates`.
- policy-run: `runId`, `runStatus` (`"new"` or `"duplicate"`).
