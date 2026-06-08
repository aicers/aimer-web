# Analysis Worker

The analysis worker (`src/lib/instrumentation/analysis-job-worker.ts`)
promotes `periodic_report_state` rows from `pending` to `ready` once
their bucket has closed and the settle window has elapsed. This page
documents the operator knobs and log signals tied to the cursor
watermark (RFC 0002 Phase 0.5 / issue #295).

## Story readiness windows

The worker also promotes `story_analysis_state` rows from `pending` to
`ready`. A story becomes ready once it has been idle for the quiet
window (no new member for `ANALYSIS_STORY_IDLE_MINUTES`) **or** once the
maximum wait since its first member has elapsed
(`ANALYSIS_STORY_MAX_WAIT_HOURS`), whichever comes first.

| Variable | Default | When used |
| --- | --- | --- |
| `ANALYSIS_STORY_IDLE_MINUTES` | `15` | Quiet window. Compared against `last_member_at` — a story idle this long becomes ready. |
| `ANALYSIS_STORY_MAX_WAIT_HOURS` | `6` | Max-wait ceiling. Compared against `first_member_at` — a still-active story becomes ready once this long has passed since its first member. |

Both are read at tick time (no process restart needed) and shorten or
lengthen analysis latency per deployment. Each value must be a positive
integer; `0`, negative, or non-numeric values are rejected and the
default is used. These windows are product-policy settle knobs, not pure
performance knobs — lowering them analyzes stories before they have
finished settling, so keep a meaningful floor.

## DAILY settle windows

The worker compares each pending DAILY row's bucket end (in the
customer timezone) against `NOW()` and the configured settle window.
Two env vars control DAILY:

| Variable | Default | When used |
| --- | --- | --- |
| `ANALYSIS_SETTLE_HOURS_DAILY` | `3` | Baseline. Applied when no strict cursor watermark covers the bucket end. |
| `ANALYSIS_SETTLE_HOURS_DAILY_WITH_WATERMARK` | `1` | Shortened. Applied when `periodic_report_state.cursor_watermark` is non-null, `cursor_watermark_quality = 'strict'`, and `cursor_watermark >= bucket_end`. |

Soft watermarks (`cursor_watermark_quality = 'soft'`) and missing
watermarks both fall back to the baseline. Story stragglers commit
late, so soft watermarks must not shorten settle.

WEEKLY and MONTHLY do not consume the watermark in Phase 0.5; the
relevant worker rows ship in a later phase. The column is still
populated on those rows so the predicate can be enabled with a single
SQL change later.

## "Settle shortened" log line

Every DAILY promotion that fired against the shortened-watermark
branch (i.e., the baseline window had **not** yet elapsed) emits a
single structured log line at `info` level:

```json
{
  "level": "info",
  "event": "analysis.daily_settle_shortened",
  "customer_id": "…",
  "period": "DAILY",
  "bucket_date": "2026-05-27",
  "tz": "Asia/Seoul",
  "cursor_watermark": "2026-05-28T01:00:00.000Z",
  "bucket_end_at": "2026-05-27T15:00:00.000Z"
}
```

The log line is suppressed for DAILY rows that would have promoted
under the baseline settle anyway (no shortening occurred). WEEKLY /
MONTHLY rows do not emit this event.

## Watermark recovery

The hot path writes the watermark from the Phase 2 ingest hook. On
hook failure the cursor-bearing `phase2.ingest` audit row carries
`cursorEventTime` / `cursorQuality` in its `details` JSONB; the
reconcile pass scans recent rows in the trailing 24 h window and
forward-patches the watermark for the customer. If the audit write
itself fails, the handler logs an error containing the cursor fields
and returns 200 — the JTI is already consumed and a retry would hit
`409 context_jti_replay`. The next envelope from the same customer
advances the watermark directly.

## Baseline-event auto-analysis (tier-B daily cap)

The worker also auto-analyzes **loose baseline events** — events that
are not members of any story (story members are analyzed at story
scope). Each ingested loose event is seeded as a held
`event_analysis_job` row and classified on a later tick from its
per-event TI/IOC verdict (`event_enrichment_state`):

- **Tier A** — a known-IOC hit. Always analyzed, **uncapped**.
- **Tier B** — a clean miss under `coverage_status = 'complete'`.
  Analyzed only within the customer's daily budget; overflow is written
  the terminal `budget_skipped` status (queryable, never retried).
- **Held** — an absent or non-conclusive verdict
  (`partial`/`unknown`/`stale`) is not classified yet. The worker drives
  a bounded `runEventEnrichment` re-check loop; a verdict that flips to a
  known-IOC hit routes to tier A, and on bound exhaustion the event falls
  back to tier B (with a metric) — never a silent `budget_skipped`.

The tier-B cap is a **seed-time reservation**: the per-`(customer,
budget_day)` count includes in-flight `queued`/`processing` rows (not
just `done`), so a backlog cannot over-enqueue past the cap. The budget
resets on the **customer-tz calendar day** (`customers.timezone`).
Queued jobs are picked in neutral chronological order (the source
`event_time`, then `received_at`), so under a low cap the **earliest**
events of the day claim the budget — there is no sender-field re-ranking.

Eligibility is re-checked when the worker claims a job, not only at seed
time. Because the worker is asynchronous, a story batch may adopt the
event as a member, or a manual/default-variant `event_analysis_result`
may appear, in the gap between seeding and pickup. In either case the now
stale auto job is cancelled to the terminal `done` status (with the
reason in `last_error`) **before** any budget or LLM spend and before it
could supersede the live leaf — so story members are never auto-analyzed
and the manual path's visible result is never overwritten.

The same eligibility check runs once more **inside the storage
transaction** — under the per-event-variant advisory lock, immediately
before the result is written — to close the window during the (longer)
LLM call itself. If a story member or a live leaf appears while the auto
analysis is in flight, the store is rolled back (nothing is superseded,
no `auto_baseline` row is written) and the job is cancelled the same way.
For the live-leaf case the lock is what makes this safe: a concurrent
manual analysis of the same variant takes the same lock, so its result is
always visible to this final check.

When an auto-analyzed leaf is stored, the worker re-dirties the periodic
report buckets the event falls into (the same dirty signal the baseline
ingest hook raises). The leaf is produced asynchronously over several
ticks — usually after the bucket's report already generated — so this
re-dirty is what makes the loose event surface in the report event path
on the next report tick rather than staying invisible until unrelated
activity re-dirties the bucket. The event dispatch runs before the report
dispatch within a tick so a leaf analyzed this tick can regenerate its
report in the same tick.

The cap resolves through three tiers (per-customer override → admin
global → env):

| Tier | Source |
| --- | --- |
| Per-customer override | `customer_baseline_analysis_cap.daily_cap` row (absence = no override) |
| Admin global | `system_settings.baseline_auto_analysis_daily_cap` |
| Env fallback | `BASELINE_AUTO_ANALYSIS_DAILY_CAP` |

| Variable | Default | When used |
| --- | --- | --- |
| `BASELINE_AUTO_ANALYSIS_DAILY_CAP` | `0` | Env-level tier-B cap (third tier). `0` disables tier B; tier A stays uncapped. |
| `BASELINE_AUTO_ANALYSIS_TIER_A_ENABLED` | `true` | Tier-A kill switch for incident response. While `false`, a known-IOC event is held (never demoted to tier B). |
| `BASELINE_AUTO_ANALYSIS_MAX_ENRICHMENT_ATTEMPTS` | `5` | Held-event enrichment re-check attempt bound. |
| `BASELINE_AUTO_ANALYSIS_MAX_ENRICHMENT_AGE_MINUTES` | `60` | Held-event enrichment re-check age bound. |

Result rows carry `event_analysis_result.origin = 'auto_baseline'` (the
manual path keeps `'manual'`) and `requested_by = NULL` (no human
requester; the worker is attributed via the audit actor). The worker
emits structured `analysis.baseline_auto.*` log lines
(`tier_a_analyzed`, `tier_b_admitted`, `budget_skipped`,
`coverage_holdfallback`, `tier_a_disabled_held`, `stale_cancelled`) for
rate monitoring.
