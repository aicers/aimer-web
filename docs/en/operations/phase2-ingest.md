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
| 500 | `database_error` | INSERT into the customer DB failed after envelope verification (e.g., FK violation, cast failure). A `phase2.ingest_failed` audit row is emitted; the context-token `jti` is NOT released — the caller must mint fresh tokens to retry. |

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
DB. A database-side failure during the per-customer INSERT emits one
`phase2.ingest_failed` row instead (with `details.error` carrying the
underlying error message). Envelope / verification failures (anything
the shared verifier throws as `EnvelopeVerificationError`) emit one
`phase2.verification_failed` row carrying `details.code` plus any
extra fields the helper attached (e.g., `externalKey`, key-expiry
metadata). `actor_id` is the context-token `sub` when the failure
happens after context-token verification, and `unknown` otherwise;
`aice_id` and `correlation_id` are populated when the verifier had
already accepted the context token.

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

## Mutation endpoints

In addition to the three ingest endpoints above, aimer-web exposes
three Phase 2 mutation endpoints that DELETE or replace previously
ingested data. They share the same multipart envelope contract,
context-token verification, jti replay store, and audit category as
the ingest routes.

| Endpoint | Schema version | Semantics |
| --- | --- | --- |
| `POST /api/phase2/withdraw` | `phase2.withdraw.v1` | DELETE specific rows by natural key |
| `POST /api/phase2/refresh-window` | `phase2.refresh_window.v1` | Atomically replace a `[from, to)` window |
| `POST /api/phase2/backfill` | `phase2.backfill.v1` | Same shape and semantics as refresh-window, distinguished only by operator intent (and audit action) |

### Withdraw

The payload carries a non-empty `withdrawals` array; each item is
discriminated by `kind`:

- `baseline_event` — `{ baseline_version, event_keys[] }`
- `story` — `{ story_id, story_version }`
- `policy_event` — `{ run_id, event_keys[] }`
- `policy_run` — `{ run_id }`

All DELETEs run in a single per-customer transaction; if any one
fails the whole call rolls back and the response is `500`. The
response counts `withdrawn` and `not_found` rows separately —
`not_found` is informational (the row was already gone), not an
error. FK cascade automatically removes `policy_event` children of a
withdrawn `policy_run` and `story_member` children of a withdrawn
`story`; the route does not issue explicit child-table DELETEs.

The Zod schema additionally rejects (with `400
payload_schema_invalid`) payloads that combine `{ kind: "policy_run",
run_id: R }` with any `{ kind: "policy_event", run_id: R, ... }` for
the same run. The run's FK cascade already removes its policy_event
rows, so the count attributed to the explicit policy_event item would
otherwise depend on item order — `withdrawn` if processed before the
run, `not_found` after the cascade ran — masking a sender bug.

Response:

```json
{
  "withdrawn": 3,
  "not_found": 1,
  "received_at": "2026-05-17T10:23:45.012Z",
  "context_jti": "550e8400-e29b-41d4-a716-446655440000"
}
```

### Refresh-window and backfill

Both endpoints atomically replace the contents of a half-open
`[window.from, window.to)` interval. They are wire-identical: same
payload shape, same response shape, same per-window advisory lock,
same DELETE-then-INSERT semantics. The only differences are the
envelope's `schema_version` claim and the success-path audit action
(`phase2.refresh_window` vs `phase2.backfill`). Use `refresh-window`
when aice-web-next ran a Force Rebuild; use `backfill` when an admin
operator triggered the call.

Payload:

```json
{
  "external_key": "...",
  "window": { "kind": "baseline_event", "from": "...", "to": "..." },
  "baseline_version": "...",
  "events": [ /* baseline_event rows; element shape matches phase2.baseline.v1 */ ]
}
```

For a `story` window, replace `baseline_version` + `events` with
`stories` (no `baseline_version` needed). The Zod schema rejects:

- Stories with `kind: "analyst_curated"` — curated stories are never
  affected by these endpoints (RFC 0002 §6).
- Rows whose `event_time` (baseline) or `time_window.start` (story)
  falls outside `[from, to)` — sender bug, fail-fast at `400
  payload_schema_invalid`.
- Payload-internal natural-key duplicates — same
  `(baseline_version, event_key)`, `(story_id, story_version)`, or
  `(story_id, story_version, member_event_key)`.
- Numeric strings in non-canonical form (`"01"`, `"010"`, etc.) for
  any `event_key`, `story_id`, `run_id`, or member `event_key`. The
  DB natural keys are `numeric` / `bigint`, so `"01"` and `"1"`
  collapse to the same row; allowing both wire forms would let
  duplicate guards miss collisions that the DB then surfaces as a
  PK violation (`500` after the JTI is consumed) or as silently
  miscounted withdraw responses.
- A `window` whose `from >= to` (zero-width or reversed interval).
  An empty interval would pass the row-membership guards (every
  comparison fails on an empty array), consume the JTI, take the
  advisory lock, delete nothing, and return `200` — indistinguishable
  from a no-op success and almost certainly a sender bug.

The DELETE filter:

- baseline: `baseline_version = $1 AND event_time >= $from AND event_time < $to`.
  Other `baseline_version` rows in the same time window are
  preserved.
- story: `kind = 'auto_correlated' AND time_window_start >= $from AND
  time_window_start < $to`. A story that *starts* before `from` but
  whose `time_window_end` extends into the window is NOT removed by
  the refresh — stories are assigned to their start time, mirroring
  the producer-side Force Rebuild contract.

Response:

```json
{
  "accepted": 12,
  "duplicates_skipped": 0,
  "deleted": 7,
  "received_at": "2026-05-17T10:23:45.012Z",
  "context_jti": "..."
}
```

`duplicates_skipped` is always `0` (the window is cleared before the
INSERTs). `deleted` is an informational count of the rows the
preceding DELETE removed. Re-running a backfill with the same body
converges to the same end state (`accepted` will equal the new
events/stories count; `deleted` will equal the previous run's
`accepted`).

### Advisory lock

Refresh-window and backfill acquire a per-window advisory lock
keyed on `phase2_window|<window_kind>|<external_key>|<from>|<to>`
via `pg_advisory_xact_lock(hashtextextended(..., 0))` (single-bigint
form). The kind segment of the key is the window's, not the
operation's — a refresh and a backfill of the **same** window
serialize against each other, which is the correctness invariant
(both DELETE+INSERT the same rows). The audit action distinguishes
intent; the lock distinguishes the window.

Concurrent refreshes of different `baseline_version` values within
the same time window touch disjoint rows but still serialize on the
lock; if profiling shows contention this could be folded in as a
follow-up.

### Replay and DB-failure semantics

The mutation endpoints share the ingest routes' replay store and
post-verification failure semantics:

- A replayed `context_jti` returns `409 context_jti_replay`,
  performs NO DB mutation, does NOT acquire the per-window advisory
  lock (a replay must not stall an unrelated concurrent refresh of
  the same window), and emits NO `phase2.{withdraw,refresh_window,
  backfill}` audit row.
- A DB failure inside the per-customer transaction (e.g. cast
  failure, FK violation) returns `500 database_error`, emits a
  `phase2.ingest_failed` audit row (the action name is shared with
  ingest by historical accident — it stands in for any
  post-verification Phase 2 mutation failure), and leaves the
  consumed `jti` in `phase2_consumed_jtis`. The caller must mint
  fresh tokens to retry.

### Audit details

Success-path actions:

- `phase2.withdraw` — `details` carries `schemaVersion`,
  `withdrawn`, `notFound`, `kindsTouched[]`.
- `phase2.refresh_window` and `phase2.backfill` — `details` carries
  `schemaVersion`, `window`, `accepted`, `deleted`, and
  `eventCountClaim` (from the envelope, for sender/receiver
  reconciliation).

Failure-path actions reuse `phase2.verification_failed` and
`phase2.ingest_failed`; the route is distinguished by `targetType`
(`phase2_withdraw`, `phase2_refresh_window`, `phase2_backfill`).
