# Analysis Worker

The analysis worker (`src/lib/instrumentation/analysis-job-worker.ts`)
promotes `periodic_report_state` rows from `pending` to `ready` once
their bucket has closed and the settle window has elapsed. This page
documents the operator knobs and log signals tied to the cursor
watermark (RFC 0002 Phase 0.5 / issue #295).

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
