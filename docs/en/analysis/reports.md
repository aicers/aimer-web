# Periodic Security Reports

A periodic security report is a single LLM-written synthesis across a
time window for one customer — it weaves together the stories and single
events already analysed in that window plus the statistical drift in the
baseline event stream. Unlike a story analysis (one LLM call about one
story), a report aggregates many leaf analyses into one narrative and
does **not** ask the LLM for scores: aimer-web computes the aggregate
scores itself from the included leaves and the baseline drift.

The page is reached from an aice-web-next dashboard card deep link, or
directly via the customer-scoped URL:

```
/customers/{customerId}/analysis/reports/{period}/{bucketDate}
```

`{period}` is **uppercase** — `LIVE` or `DAILY` (Phase 2). The customer
id appears in the path because a `(period, bucket_date)` pair is not
globally unique — bucket date `2026-05-26` exists for every customer.
A lowercase period in the URL returns `404` rather than redirecting, so
the UI route and the API path validation share one case convention.

Access is existence-hiding and matches the summary and regenerate
endpoints: a caller who is not a member of the customer — or a request
for a report that does not exist — returns `404`, while a member without
the `reports:read` permission, or a rejected bridge session, returns a
real `403` (a permission notice, not a normal page).

![Periodic report detail page, showing the priority badge, aggregate severity and likelihood scores, MITRE ATT&CK technique chips, and the executive summary, story highlights, baseline drift, notable events, and recommendations sections](../../assets/report-detail.en.png)

## LIVE vs DAILY cadence

Two report periods are produced today:

- **LIVE** — a rolling snapshot covering the trailing 24 hours. LIVE
  rows use a synthetic bucket date (`1970-01-01`); the report is
  regenerated on a fixed cadence (`ANALYSIS_LIVE_REFRESH_MINUTES`,
  default 60 minutes) as long as the period's source data is not
  archived. Each refresh bumps the report generation.
- **DAILY** — one report per calendar day in the customer's timezone.
  A DAILY bucket becomes eligible once the day has closed and the
  settle window has elapsed (shortened when a strict cursor watermark
  confirms ingest is complete). It is regenerated when new in-window
  source data arrives ("dirty" re-queue).

`WEEKLY` and `MONTHLY` periods are defined but not yet produced — the
worker does not process them and the regenerate endpoint rejects them
with `400 period_not_yet_supported`. They arrive in a later phase.

No operator action is needed for either period: a background worker
seeds, schedules, and runs the LLM calls. The **Regenerate** button
(below) is for forcing an out-of-cadence refresh.

## How a report is built

The worker pipeline runs without operator action:

1. The state worker tracks per-`(customer, period, bucket_date, tz)`
   readiness and seeds a real `periodic_report_job` row for the default
   `(tz, language, provider, model)` variant against every `ready` or
   `dirty` LIVE/DAILY state row. LIVE variants are also re-queued when
   their per-variant `next_due_at` cadence elapses (skipping archived,
   timezone-superseded rows).
2. The dispatcher picks `queued` jobs with `FOR UPDATE SKIP LOCKED`,
   advisory-locked per `(customer_id, period, bucket_date, tz)`, with the
   same exponential-backoff predicate as story analysis.
3. The input builder deterministically selects the **top stories**
   (eligible only when the story's state is `ready` and a non-superseded
   result exists for the variant, and the canonical story window
   overlaps the bucket) and **top events** (variant-matched event
   analyses whose deduped baseline event time falls in the bucket,
   excluding events already covered by the chosen stories). It also
   computes the **baseline aggregates**: deduplicated event counts, a
   category distribution, and the per-category delta versus the previous
   period.
4. Every included leaf narrative is re-namespaced into a single
   report-scope token namespace (`<<REDACTED_*_R{j}_*>>`) so the same
   placeholder in two different leaves cannot collide, and the bundle is
   sent to aimer's `generatePeriodicSecurityReport` mutation under mTLS.
   The worker actor is `system:analysis-worker` with a stable
   `system:periodic-report` sentinel AICE id, because a report spans
   multiple AICE environments and has no single canonical one.
5. The returned narrative is scanned for residual tokens or plaintext
   PII (a hallucinated decode fails the job and is never stored), then
   written to `periodic_report_result`, followed by the auth-DB job
   finalize.

Retryable failures (5xx, transport, mTLS error) re-queue with backoff up
to `ANALYSIS_MAX_ATTEMPTS`. Fatal failures (4xx, hallucination detected,
missing or mismatched redaction policy versions across the included
leaves) mark the job `failed` immediately.

## Priority tier and aggregate scores

The header shows the report's priority and its two aggregate scores:

- **Priority tier** — `CRITICAL`, `HIGH`, `MEDIUM`, or `LOW`, rendered
  as a colored badge. The tier is the **maximum** over every included
  leaf's own priority tier and the tier that the baseline drift maps to
  through the same 4×4 matrix story analysis uses. Deriving it from the
  leaves directly (rather than from the aggregate scores) preserves
  "leaf monotonicity": a report is never tagged below the worst leaf it
  cites, even when that leaf's tier was raised by an IOC or member-count
  floor that the raw score does not reflect.
- **Aggregate severity / likelihood scores** — `0.000`–`1.000`. Each is
  the maximum, per axis independently, over the included leaves' scores
  and the baseline drift signal. They are **informational** display
  values (`score_kind: "aggregate"`), not the input to the tier.

### Baseline drift

The baseline-drift signal compares the window's event-category
distribution against the previous period (the prior 24 hours for LIVE,
the prior calendar day for DAILY):

- **drift severity** — the largest per-category count change versus the
  prior period, normalized and clamped to `[0, 1]`.
- **drift likelihood** — `1.0` when any per-category fractional change
  exceeds `ANALYSIS_BASELINE_DRIFT_NOISE_THRESHOLD` (default `0.3`),
  else `0.0`. Statistical drift past the noise floor is treated as a
  high-confidence signal.

When the previous period had no events (first bucket), both drift
signals are `0.0`. The LLM renders these statistics as the report's
**Baseline drift** section.

## MITRE ATT&CK techniques

Next to the priority badge, the page renders the report's
`aggregate_ttp_tags` — the deduplicated, sorted union of every included
leaf's MITRE ATT&CK technique IDs. Each chip shows the technique ID;
hovering reveals the official technique name (e.g. `T1078` → "Valid
Accounts") from the vendored ATT&CK bundle. The LLM is given this set
and is instructed to reference techniques by ID in the narrative, but
the stored union is computed deterministically from the leaves — the
LLM cannot add or drop a technique from the column.

## Report sections

The body renders the five narrative sections the LLM returns, each with
report-scope tokens restored to plaintext:

- **Executive summary** — the period-framed headline. This is the
  section the day-over-day near-duplicate check watches: two consecutive
  days that read as paraphrases of each other signal a dull prompt or an
  input-builder bug.
- **Story highlights** — the top-K analysed stories woven into prose,
  with the strongest leaf factors quoted where precise.
- **Baseline drift** — a reading of the statistical drift described
  above.
- **Notable events** — single events not already covered by the story
  highlights.
- **Recommendations** — actionable next steps for the period.

Tokens that cannot be restored (decrypt failure, a superseded leaf,
out-of-range index) are passed through unchanged so the page still
renders; hallucinated decodes are blocked at write time and never reach
this view.

## Metadata fields

Below the header the page shows the report metadata: language, provider
/ model, the provider-reported model snapshot, the prompt version, the
account that triggered the latest generation (or `system` for a regular
worker tick), and the request timestamp. The header line also names the
period, the bucket (or "now" for LIVE), the customer timezone, and the
generation.

## Force regenerate

Operators with `reports:create` can force an out-of-cadence rerun via
the **Regenerate** button at the bottom of the page.

![Regenerate confirmation modal, warning that a fresh LLM call is issued across the period's stories, events, and baseline statistics and that the latest generation is superseded, with Cancel and Regenerate buttons](../../assets/report-regenerate-modal.en.png)

The confirmation modal states that a fresh LLM call is issued across the
period's analysed stories, events, and baseline statistics, and that the
latest generation is superseded once the new result lands. The previous
result row is preserved with a `superseded_at` stamp; nothing is
overwritten in place.

Submitting the modal calls
`POST /api/customers/{customerId}/analysis/report/{period}/{bucketDate}/regenerate`
(optionally with `?tz=&lang=&model_name=&model=` to target a non-default
variant — unlike story analysis, `tz` is accepted because reports are
timezone-keyed). Behaviour:

- The job row's `generation` is bumped by one (or `1` if no prior row
  for the variant exists), `status` resets to `queued`, `attempts`
  resets to `0`, and the LLM call begins on the next worker tick. Force
  is allowed even past the automatic generation cap.
- Bridge sessions and members without `reports:create` are rejected with
  `403`. A caller that is not a member of the customer at all gets
  `404 report_state_not_found` (existence-hiding, uniform with the page
  and the summary endpoint).
- A missing state row returns `404 report_state_not_found`; a state row
  that has been archived by a timezone change returns
  `409 source_unavailable`. `WEEKLY` / `MONTHLY` return
  `400 period_not_yet_supported` once the caller has cleared auth.

While the regenerate is queued, the page shows a yellow status banner
naming the new generation number. Refresh once the worker has written
the new result.

## Cross-system deep link

aice-web-next dashboard cards consume the matching summary endpoint to
decide whether to surface a deep-link badge for a period:

```
GET /api/customers/{customerId}/analysis/report/{period}/{bucketDate}/summary
```

The endpoint returns either `{exists: false}` (no report yet) or a
content-free payload with `priority_tier`, the two aggregate scores,
`score_kind: "aggregate"`, and a `link` to this page. The `link` carries
the period as **uppercase** so following it lands on the page route
without a case-insensitive redirect, and is customer-scoped so it
resolves to the right report regardless of which customer the opening
tab has selected. When the summary was requested for a non-default
variant (`?tz=&lang=&model_name=&model=`), the `link` forwards those
same query params so following it opens that variant rather than the
default. The badge itself (priority tier and aggregate scores
only, no section content) is rendered by aice-web-next; see the
aice-web-next manual for its screenshot.

Section content, TTP tags, and factors are full-report-viewer concerns
and stay out of the summary, so the badge cannot leak report detail. The
summary applies the same existence-hiding policy as the page and the
regenerate route: a non-member gets `404 report_state_not_found`,
members without `reports:read` get `403 Forbidden`, and rejected bridge
sessions get `403 bridge_not_allowed`.
