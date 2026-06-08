# Refreshing periodic reports after a model change

When you change a customer's [default analysis model](default-model.md) and
then re-analyze the underlying leaves
([story](reanalyze-backfill.md) and [event](event-leaf-reanalysis.md)), the
leaves move to the new model — but an existing periodic **report** still
**aggregates the old leaf set** until it is regenerated. A periodic report's
headline scores and priority tier are computed from the story and event
leaves selected for that report, so the report does not reflect the
re-analyzed leaves until it is **refreshed**.

The **report-variant refresh** regenerates scoped periodic report variants
under the new model so they re-aggregate the freshly re-analyzed leaves. It
is the **third** panel on the re-analysis page, after the story and event
re-analysis panels.

This is a deliberate, operator-triggered action. It is **never started
automatically** by changing the default model, because regenerating reports
spends model-call budget.

> **Screenshot placeholder.** The panel shows live report-variant counts
> sourced from customer data; a real-data capture is added when a stack with
> representative data is available.

## Run it after the leaf re-analyses

A report aggregates **both** story and event leaves, so refreshing it before
those leaves are re-analyzed would just re-aggregate the **old** leaf set and
advance nothing. The refresh therefore **automatically gates** each report on
the story- and event-leaf re-analyses being complete:

- Each report variant is checked against **both** leaf drain signals over
  **that report's own period window** — live (last 24 hours), daily (1 day),
  weekly (7 days), or monthly (1 calendar month) — not the recent-window you
  pick below. An older weekly or monthly report can aggregate leaves well
  outside the recent window, so the gate looks at the report's full
  aggregation window.
- A report whose story **or** event leaves are not yet re-analyzed over that
  window is reported as **gated** and is **not** refreshed. Re-run the
  refresh after the leaf re-analyses finish.

The gate is enforced in code — you cannot refresh a report over leaves that
are still on the old model.

## Who can run it

| Role | Scope |
| --- | --- |
| **System Administrator** | Any customer (from the admin re-analysis page). |
| **Analyst** | Customers they are assigned to (from Customer Settings → re-analysis). |

Managers and Users cannot launch a refresh.

## How to launch

1. Change the customer's default analysis model and re-analyze the story and
   event leaves (the first two panels). After those drain, return to the
   re-analysis page.
2. The **Refresh periodic reports** panel shows a **scope preview**.
3. *(Optional)* Adjust the scope before confirming:
   - **Target language** — which language's reports the refresh targets.
     Report variants are language-specific. Defaults to your interface
     language.
   - **Recent window (days)** — which report **buckets** are in scope, by
     bucket date. Defaults to **7 days**. (This is separate from the
     per-report drain-gate window described above.)
   - **Per-run cap** — an optional upper bound on how many report variants
     this run refreshes. Leave it blank for no cap. Variants beyond the cap
     are reported as **limited**.
   - **Periods** — restrict to specific report periods (live / daily /
     weekly / monthly). All periods are in scope by default.

   The preview counts update to match whatever scope you enter.
4. Review the preview counts, then choose **Refresh N report variants** and
   **confirm**. The refresh runs and shows its categorized outcome counts.

The confirmation is **required** — nothing runs until you confirm. The
preview shows **counts and scope only**; it never shows a monetary figure.
The **target model** is fixed to the customer's new default.

## Scope and defaults

The run is bounded so it can never silently refresh all of history:

- **Customer** — the customer whose model changed. A run is single-customer.
- **Target variant** — the customer's new default `(model)` for the chosen
  language.
- **Recent window** — by default the last **7 days** of report **buckets**.
  This bounds *which buckets* are enqueued; it is distinct from the
  per-report drain-gate window, which is derived from each report's period
  and may span far more than 7 days.
- **Periods** — all four by default; restrict as needed.
- **Per-run cap** *(optional)* — an upper bound on how many variants a single
  run refreshes. Variants beyond the cap are reported as **limited**.

### How a refresh runs

A refresh is **not** a new analysis worker. Each refreshed report is a
**generation bump** on the report job, which the existing periodic-report
worker then drains and regenerates. That worker is already throttled per tick
(`ANALYSIS_JOB_BATCH_SIZE`) and capped per variant (`ANALYSIS_MAX_GENERATION`,
default 50). The recent-window scope and the optional per-run cap bound the
enqueue burst on top of that, keeping the cost burst from report regeneration
separate from — and after — the leaf re-analysis burst.

## What the counts mean

The preview and the run report use the same categories, so nothing is
silently dropped:

| Category | Meaning |
| --- | --- |
| **To refresh** | Report variants that will be regenerated under the new model. |
| **Gated** | The variant's story or event leaves are not yet re-analyzed over its period window. Skipped — re-run after the leaf re-analyses finish. |
| **Already queued or processing** | A regeneration is already in flight for the variant; skipped so it is never double-bumped. |
| **At the regeneration cap** | The variant has reached `ANALYSIS_MAX_GENERATION`; reported, not bumped past the cap. |
| **Source unavailable** | The report's source state was archived (retention-swept), so it cannot be regenerated. |
| **Limited** | Refreshable variants dropped by the per-run cap. Run again to continue. |

### Idempotency

Re-running is safe. Each scoped variant is refreshed **at most once per
run**, and a variant already queued or processing is skipped — so a second
run does not double-bump a report or re-spend budget on one that is already
regenerating. A variant at the regeneration cap is reported as capped rather
than bumped past it.
