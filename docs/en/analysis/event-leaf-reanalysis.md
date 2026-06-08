# Re-analyzing event leaves after a model change

When you change a customer's [default analysis model](default-model.md),
the change applies to **future** analyses only — existing results are left
untouched. To make a customer's existing data reflect the new model, an
operator can launch a **scoped, cost-bounded re-analysis**. This page
covers the **event-leaf** part of that re-analysis.

A periodic report's aggregate scores and priority tier are computed from
**both** story leaves and **event** leaves selected for the report. After
a default-model change, only leaves already on the new model count toward
the report-model scores. Re-analyzing the event leaves under the new model
restores complete coverage so that — once the report itself is refreshed —
the aggregate is computed over the full set again.

This is a deliberate, operator-triggered action. It is **never started
automatically** by changing the default model, because re-analysis spends
model-call budget.

> **Screenshot placeholder.** The panel shows live event counts sourced
> from customer data; a real-data capture is added when a stack with
> representative data is available.

## Who can run it

| Role | Scope |
| --- | --- |
| **System Administrator** | Any customer (from the admin re-analysis page). |
| **Analyst** | Customers they are assigned to (from Customer Settings → re-analysis). |

Managers and Users cannot launch a re-analysis.

## How to launch

1. Change the customer's default analysis model. After a successful
   change, the section offers **Re-analyze existing data**.
2. Open the re-analysis page from that offer. The **Re-analyze event
   leaves** panel shows a **cost preview** for the recent window.
3. *(Optional)* Adjust the scope before confirming:
   - **Target language** — which language's report leaves the run targets.
     Report variants are language-specific, so a run re-analyzes one
     language at a time. It defaults to your current interface language;
     switch it to backfill the other language's leaves. The preview, the
     confirmation, and the launched run all show the exact target language
     so it is never implicit.
   - **Recent window (days)** — how far back the run reaches, on the
     report's event-time basis. Defaults to **7 days**. A shorter window
     re-analyzes fewer events.
   - **Per-run cap** — an optional upper bound on how many events this run
     re-analyzes. Leave it blank for no cap. Events beyond the cap are
     reported as `cap_excluded`.

   The preview counts update to match whatever scope you enter, so you can
   see the effect before committing.
4. Review the preview counts, then choose **Re-analyze N event leaves**
   and **confirm**. The run starts in the background on exactly that scope;
   the page shows live progress and a **Cancel** control. After the run
   reaches a terminal state (completed, cancelled, or failed) the page keeps
   showing the last run's frozen scope and its categorized outcome counts,
   so a capped or cancelled run can still be audited.

The confirmation is **required** — nothing runs until you confirm. The
preview shows **counts and scope only**; it never shows a monetary figure.
The **target model** is fixed to the customer's new default — the model you
just changed to — so a run always re-analyzes *toward* that new model.

## Scope and defaults

The run is bounded so it can never silently re-analyze all of history:

- **Customer** — the customer whose model changed.
- **Target variant** — the customer's new default `(model)` for the chosen
  language. This is the variant the run re-analyzes *toward*.
- **Recent window** — the last **7 days** by default, measured on the same
  event-time basis the periodic report uses to select events. Only events
  in this window that **already have an existing analysis** are in scope
  (the backfill re-analyzes existing leaves, not never-analyzed events).
- **Per-run cap** *(optional)* — an upper bound on how many events a single
  run re-analyzes. Events beyond the cap are reported as `cap_excluded`.

### Self-paced cost control

Event re-analysis is synchronous — one model call per event — so the
background run **paces its own calls** rather than relying on a queue
worker. It re-analyzes a small batch per tick on a fixed interval, so the
model-call burst stays bounded. The recent-window scope and the optional
per-run cap bound total cost further. The pacing batch size and interval
are configurable for an operator who needs to tune throughput
(`EVENT_BACKFILL_BATCH_SIZE`, `EVENT_BACKFILL_POLL_INTERVAL_MS`).

## What the counts mean

The preview and the run report use the same categories, so nothing is
silently dropped:

| Category | Meaning |
| --- | --- |
| **To re-analyze** | Existing event leaves not yet on the new model — the events the run will re-analyze. |
| **Already on the new model** | Already on the target variant; counted, but not re-run. |
| **Source unavailable** | The redacted source event was removed by retention, so it cannot be re-analyzed here. Skipped — not a failure. |
| **Excluded by cap** | Re-analyzable events dropped by the per-run cap. |
| **Failed** | A re-analysis that errored (for example, the model was unavailable). Reported distinctly. |

A **source-unavailable** event can never be re-analyzed from stored data
(re-ingesting a fresh raw event is a separate aice-web-next action), so it
does not block completion.

### Idempotency

Re-running is safe. An event that already has a current leaf for the
target variant is skipped, so a second run does not duplicate work and does
not re-spend budget on events that are already done.

## Relationship to the full re-analysis

Event-leaf re-analysis is one part of a three-step sequence:

1. **Story leaves** are re-analyzed under the new model.
2. **Event leaves** are re-analyzed under the new model *(this page)*.
3. **Reports** are refreshed once **both** the story- and event-leaf scopes
   are fully re-analyzed (drained).

The report refresh waits for both leaf re-analyses to drain, so a report is
only recomputed once its underlying leaves are complete under the new
model. Source-unavailable events are excluded from the drain check, so a
retention-swept event never blocks the refresh indefinitely.

## Cost implications

Each re-analyzed event makes one model call. The cost of a run is therefore
proportional to the **To re-analyze** count in the preview — review it
before confirming. Use a shorter window or a per-run cap to bound cost, and
remember the run is paced so the spend is spread over time rather than
issued all at once.
