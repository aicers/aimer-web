# Phase 0 acceptance suite

RFC 0002 round-12 ([#325](https://github.com/aicers/aimer-web/pull/325))
amends the Phase 0 verification gate to accept either

- (a) 48h real-environment observation, or
- (b) a deterministic acceptance suite that exercises every documented
  state-transition path.

This document covers path (b). The suite lives at
`src/lib/instrumentation/__tests__/phase0-acceptance.db.test.ts` and
runs as part of `pnpm test:db` — no separate script and no new CI job.

## Scope

The suite covers the ten Phase 0 scenarios in scope per issue
[#326](https://github.com/aicers/aimer-web/issues/326):

| # | Scenario |
| --- | --- |
| 1 | Story idle window elapses (15 min) → `ready` |
| 2 | Story max-wait rule (6 h) wins over still-active idle window → `ready` |
| 3 | Late member after `ready`+`done` → `dirty` → worker re-marks `done`, generation++ |
| 4 | Refresh-window envelope overlaps a closed DAILY bucket → `dirty` |
| 5 | Regular Phase 2 batch with `event_time` inside a closed DAILY bucket → `dirty` |
| 6a | DAILY bucket end was ≥ 3 h ago, no recent ingest → `ready` |
| 7 | WEEKLY bucket end was ≥ 6 h ago, no recent ingest → `ready` |
| 8 | MONTHLY bucket end was ≥ 12 h ago, no recent ingest → `ready` |
| 10a / 10b | Archive on window-replace deletion; unarchive in place on re-insertion |
| 11a / 11b / 11c | Reconciliation seed cleanliness + forward-patch + idempotency |

Scenarios 6b / 6c (strict-watermark shortened settle), 9 (LIVE
`next_due_at` requeue), and 12 (generation-cap dry-run exemption) are
**deferred** to the phases that implement their underlying features
(Phase 0.5 / Phase 1 / Phase 1). See issue #326 §"Evaluation" for the
reasoning.

## How the suite works

The Phase 0 worker's readiness / settle / quiet-window predicates are
SQL `NOW()` calls. To make them deterministic, the worker now sources
its `now` from `getCurrentTimestamp()` in
`src/lib/instrumentation/time.ts` and threads the value into every SQL
statement as a `$n::timestamptz` bind parameter. The suite mocks the
seam through `vi.mock("@/lib/instrumentation/time", ...)` and pins
`mockNow` to a fixed instant per scenario; source-side columns
(`first_member_at`, `last_member_at`, `updated_at`, ...) are stamped as
`mockNow − N` in JS rather than via SQL `NOW()`. Together this makes
every tick assertion exact rather than wall-clock-sensitive.

`runAnalysisJobTickOnce` captures `nowIso` once at the top of the tick
and threads the resulting value through every sub-call, so a state row
promoted to `ready` at the start of the tick and its corresponding job
row inserted at the end share exactly one `last_ready_at` /
`last_generated_at` timestamp. The recovery pass runs outside the tick
transaction and captures its own `nowIso` at entry.

## Running locally

The suite runs against a real PostgreSQL instance — bring one up via
the project's `docker-compose.yml` (or any equivalent local Postgres)
and export `DATABASE_URL` / `DATABASE_ADMIN_URL` as documented in the
README. Then:

```sh
pnpm test:db -- phase0-acceptance
```

This invokes vitest's existing `test:db` script with a filter that
matches just this file. The suite typically completes in under 30
seconds on a developer laptop (no real timers, no LLM calls).

To run the suite alongside the other DB tests as CI does:

```sh
pnpm test:db
```

## What "passing" looks like

The Phase 0 gate is considered passed for a given environment when:

1. CI for the branch is green — the existing `pnpm test:db` step is the
   gate.
2. An operator has reviewed one fixture run end-to-end on the target
   environment and confirmed:
   - Every scenario asserts via SQL inspection (not in-memory mock
     checks), and the post-tick auth-DB state matches the scenario's
     description.
   - No scenario relies on wall-clock elapsed time inside the test
     (`getCurrentTimestamp` is mocked; SQL `NOW()` is no longer reached
     from time-dependent worker predicates).
   - The full `pnpm test:db` run produces no warnings about skipped
     scenarios, dropped fixtures, or stuck rows.

## When to re-run

Re-run the suite locally before merging any change that affects:

- `src/lib/instrumentation/analysis-job-worker.ts` — readiness, settle,
  quiet-window, dispatch, or recovery logic.
- `src/lib/instrumentation/time.ts` — the clock seam itself.
- `src/lib/analysis/state.ts` or `src/lib/analysis/ingest-hooks.ts` —
  ingest-hook state mutations.
- `src/lib/analysis/reconcile.ts` — reconciliation seed / forward-patch.
- Any migration that adds, removes, or alters columns referenced by the
  Phase 0 worker (`story_analysis_state`, `story_analysis_job`,
  `periodic_report_state`, `periodic_report_job`).
- The RFC 0002 §"Readiness and scheduling" or §"Dirty transitions"
  sections in `rfcs/0002-*` — if the rules change, the suite must
  change with them.

## Out of scope

- Auto-running the suite on a schedule — CI on PR is sufficient.
- Extending the suite to Phase 1 / 2 / 3 verification — those gates are
  qualitative (operator review, near-duplicate detection, comparative
  framing) and cannot be replaced by a fixture.
- Property-based testing across random scenario permutations.
