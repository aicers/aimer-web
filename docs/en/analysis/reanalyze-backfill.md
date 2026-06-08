# Story-leaf re-analysis backfill

When a customer's [default analysis model](default-model.md) changes, the
change applies to **future** analyses only — every existing story analysis
stays on the **old** model. New default-model reports still read as
complete (they fall back to the old-model leaves for coverage), but their
aggregate scores are computed from the initially small set of new-model
leaves, so they can **understate** until enough leaves are re-analyzed.
The coverage indicator on the report surfaces this transient gap.

The **story-leaf re-analysis backfill** shortens that transition window:
it re-queues a customer's existing **story** analyses under the new
default model. It is a deliberate, cost-bounded, operator-launched action
— it is **never** started automatically by changing the default.

> This page covers **story leaves** only. Re-analyzing **event** leaves
> and refreshing **reports** are separate, sequenced actions delivered
> alongside this one; the report refresh runs only after the story-leaf
> backfill has drained.

## Who can run it

The backfill uses the same permissions as the per-customer default-model
control it is launched from:

- **System Administrator** — any customer (admin surface).
- **Analyst** — their assigned customers (Customer Settings surface).

Managers and Users cannot run it.

## Where to find it

After a successful default-model change, the model-change section offers
**Re-analyze existing data**, which opens the re-analysis page for that
customer. The page hosts the backfill controls:

- The analyst surface: **Customer Settings → Re-analyze existing data**.
- The admin surface: **Admin → Customers → (select a customer) →
  Re-analyze**.

The backfill always targets the customer's **current effective default
model** — you scope the run, but you do not pick an arbitrary target
model.

## Scoping the run

Two enqueue-side controls bound how much work a run queues:

- **Recent days** — only stories whose most recent activity falls within
  this many days are considered. The default is a conservative **7 days**.
  Tick **All history** to remove the time bound (never the default).
- **Per-run cap** (optional) — an upper bound on how many leaves a single
  run queues. Leaves left out by the cap are reported as **Excluded by
  cap**; run again to continue from where it stopped.

These bound the **enqueue** side. The worker that drains the queue is
already throttled independently (a fixed per-tick batch size and a
maximum generation), so a large run is spread over many ticks rather than
sent to the model all at once — the same throttling the first-tick
analysis backlog relies on.

## Cost preview and confirmation

Before anything is queued, the page shows a **preview** of the run: the
target model and per-category counts. You must tick the explicit
confirmation before the **Start re-analysis** button is enabled — a run
never proceeds without it. The preview reports counts and scope only; it
does **not** show a monetary figure.

The preview and the after-run progress break the scope into distinct
categories so nothing is silently dropped:

| Category | Meaning |
| --- | --- |
| **Leaves to re-analyze** | New leaves to seed plus failed leaves to re-queue under the new model. |
| **Already current** (`coalesced`) | A leaf already analyzed (or in flight) under the new model — left untouched. |
| **Pending source change** (`skipped_dirty`) | The story's source changed and is awaiting a normal refresh; the backfill leaves it for the worker rather than double-queueing. |
| **Source removed** (`source_unavailable`) | The story's source was archived or deleted — it cannot be re-analyzed, so it is skipped, not queued into a job that would only fail. |
| **Excluded by cap** (`cap_excluded`) | In-scope leaves left out by the per-run cap. |

## Idempotency

Re-running the backfill over the same scope is safe and does not
double-queue:

- A leaf already **queued / processing / done** under the new model is
  **coalesced** (left untouched) — no duplicate work, no generation bump.
- A **failed** leaf is **re-queued** at the same generation so the worker
  retries it.
- Only a genuinely **absent** leaf is newly seeded.

This is deliberately not the single-artifact **force regenerate** path,
which bumps the generation unconditionally.

## Progress

The page exposes a **Progress** check for the current scope: how many
in-scope leaves are still **outstanding** versus fully re-analyzed
(**drained**) under the new model. A leaf counts as drained only once its
new-model analysis is **done** and its source is not mid-change; a leaf
whose new-model analysis is missing, queued, processing, or **failed**
keeps the scope un-drained. Stories whose source was removed are excluded
— they can never be re-analyzed, so they never block progress.

This progress signal is also what gates the later **report refresh**: a
report is not refreshed under the new model until its scope's story leaves
have drained, so a refresh never re-aggregates a stale, not-yet-re-analyzed
set.

## Cost implications

Re-analyzing leaves calls the model once per leaf, so a run's cost scales
with the number of leaves it queues. Keep runs bounded:

- Start with the default recent window; widen it only when needed.
- Use the per-run cap for very large customers and run repeatedly, letting
  the worker drain between runs.
- Remember the backfill only **shortens** the transition window — reports
  stay complete via fallback coverage even before it finishes, so there is
  no need to re-analyze all history at once.
