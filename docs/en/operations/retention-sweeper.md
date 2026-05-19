# Retention Sweeper

This page is for operators. It describes the background worker that
enforces per-customer retention by deleting ingestion and analysis
rows past their cutoffs, where the cutoffs come from the
`customer_retention_policy` row in `auth_db`.

The sweeper is a single in-process worker installed by `register()`
in `src/instrumentation.ts`. There is no operator-facing UI; control
is via environment variables and the audit log.

## How retention is enforced

Each tick reads `customers × customer_retention_policy` from
`auth_db` (filtered to `database_status = 'active'`) and for every
active customer checks out a dedicated `PoolClient` from the shared
per-customer runtime pool (`src/lib/db/customer-runtime-pool.ts`,
also used by the Phase 2 ingest writes) and opens one transaction against
that customer's `customer_db`. Inside the transaction the sweeper:

1. Tries a transaction-scoped advisory lock keyed on the customer
   UUID. If the lock cannot be acquired (a peer replica is already
   sweeping this customer) the worker rolls back and moves on; no
   audit row is emitted in that case.
2. Computes `cutoff_ingestion = NOW() - ingestion_days` and
   `cutoff_analysis = NOW() - analysis_days` (or `NULL` for
   unlimited analysis retention) **once** for the tick, and threads
   the same values through every `DELETE`.
3. Sweeps the per-table rows past the cutoff. `story_member` and
   `policy_event` are removed via the existing `ON DELETE CASCADE`
   from their parents; the sweeper counts them under `FOR UPDATE`
   to keep the audit numbers exact even under concurrent ingestion.
4. Runs the `event_redaction_map` cascade pass: a map row is
   deleted only when no row in any of the four redacted-referent
   tables (`detection_events`, `baseline_event`, `story_member`,
   `policy_event`) **and** no row in `event_analysis_result`
   references its `(aice_id, event_key)`. The referent-existence
   predicate and the `(aice_id, event_key)` lock order live in
   `src/lib/redaction/cascade.ts` so this sweep and the planned
   retro-redact staleness scan (#253) cannot drift apart on the
   join shape.

If any step throws, the entire customer transaction rolls back and
the next tick re-runs the customer from scratch. Deletion is
idempotent, so a rolled-back tick converges on the next pass.

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `RETENTION_SWEEP_INTERVAL_MS` | `3600000` (1 hour) | Tick interval in milliseconds. Bounds the worst-case retention drift to roughly one tick. Set lower for faster reaction in dev/QA, higher only when DB load needs to be smoothed; do not set below a few minutes in production. |

Retention thresholds themselves are not configured via environment
variables — they live in `customer_retention_policy` and are edited
per customer (see #252).

## Audit events

Every tick that takes the customer-db lock emits a
`retention_sweep.tick_started` event before any sweep query runs.
A `retention_sweep.tick_completed` event is emitted **only when at
least one row was deleted**; silent ticks are intentionally not
logged to keep the audit signal-rich. A
`retention_sweep.tick_failed` event is emitted on any failure,
including failures *before* the customer-db transaction starts —
a connect failure (customer DB unreachable), a `BEGIN` failure, or
an advisory-lock query failure all surface as `tick_failed` audit
rows so operators see the failure in the audit log rather than
only in stderr. The missing-policy invariant (see below) also
produces a `tick_failed` row. All three events are visible in the
audit log viewer (see [Audit Logs](../audit-logs.md)).

The `tick_completed.details.deleted_by_table` field carries the
per-table row counts, with the `story_member` and `policy_event`
counts taken under the `FOR UPDATE` lock — they reflect the number
of rows actually cascaded by the parent `DELETE`, not the parent's
own `rowCount`.

## Missing-policy invariant

An active customer must have a `customer_retention_policy` row.
Provisioning inserts the row at customer creation, and the
backfill in migration `0023_backfill_customer_retention_policy.sql`
covers customers that pre-existed the table. If the sweeper finds
an active customer with no policy row, it emits
`retention_sweep.tick_failed` with
`error_message = 'missing_retention_policy'` and skips the
customer for that tick. The customer-db is **not** opened in this
case — there is no transaction and no partial deletion to roll
back. Investigate the missing row before the customer's next tick.

## What is **not** controlled by this worker

- **Per-row redaction** (the redaction policy version stamped on
  ingested events) — see `src/lib/redaction/`.
- **Retroactive re-redact** for tightened policy windows — owned
  by the redaction job (#253).
- **Customer retention policy editing UI** — owned by #252. The
  worker reads `customer_retention_policy` on every tick; the row
  takes effect on the next sweep pass without any "Apply to
  existing data" action.
