# Suspicious Events

A suspicious event is a detection forwarded by aice-web-next — a
suspected threat. The suspicious events list is the customer-scoped index
of the **analyzed** events for a customer, linking into the existing
[event analysis detail page](../analysis-result.md).

```
/customers/{customerId}/analysis/events
```

<!-- Screenshot placeholder (#392): suspicious events list page showing
     priority-sorted rows with the AICE environment, severity/likelihood,
     and priority badge, plus the priority + time-window filter bar.
     Capture from a stack with real aice-web-next data once available. -->

This is a **new customer-level segment**. The event detail route is
per-AICE-environment (`aice/{aiceId}/events/{eventKey}/analysis`), but a
customer-wide list spans many AICE environments, so the list cannot live
under a single `aice/{aiceId}` path.

## What it lists

The list shows **analyzed** events only — those that have an analysis
result (`event_key`, priority tier, and scores). Raw, un-analyzed
detections have no `event_key` or priority and are out of scope for this
list.

Each row resolves to a single canonical variant per event: the latest
generation of the default language/model that is not superseded, so an
event never appears twice.

### Detail links carry the variant

Each row links to the event detail page **with the canonical variant
query params**:

```
/customers/{customerId}/aice/{aiceId}/events/{eventKey}/analysis?lang=…&model_name=…&model=…
```

The event detail page is keyed by `(lang, model_name, model)` and returns
`404` when `model_name` or `model` is absent (it defaults only `lang`).
The list therefore always pins all three so the link resolves to the
analyzed event rather than a `404`.

## Ordering

Events are listed **highest risk first**, with every direction pinned:

1. **Priority tier** — `CRITICAL` > `HIGH` > `MEDIUM` > `LOW`, sorted by
   an explicit integer rank (never the raw `priority_tier` text).
2. **Severity score**, descending.
3. **Likelihood score**, descending.
4. **Requested-at** time, descending.
5. **AICE environment ID**, ascending — stable tiebreak.
6. **Event key**, ascending — stable tiebreak.

## Pagination

The list paginates server-side with a **keyset** cursor (not an offset),
default page size 25. A **Next page** link appears when more rows remain
and carries an opaque cursor encoding every ordering-key component, plus
the active filters.

## Filtering

- **Priority** — show only one tier, or all.
- **Time window** — limit to events requested within the last 24 hours,
  7 days, or 30 days, or show all time.

Changing a filter resets pagination to the first page.

## States

- **Empty** — a "no suspicious events match the current filters" notice.
- **Loading** — a loading placeholder while the page resolves.
- **Error** — an error notice with a **Try again** action.

## Access control

The list requires `analyses:read`. The denial mapping matches the report
index: a non-member or non-existent customer returns `404`
(existence-hiding); a member without `analyses:read`, or a rejected
bridge session, returns a real `403`.
