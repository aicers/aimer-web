# Default Analysis Model

The **default analysis model** is the model new analyses for a customer
use by default. It is a standing, DB-backed setting resolved in three
tiers, so different customers can use different models (for cost or
quality trade-offs) without an environment redeploy.

This is a separate layer from the one-off model an analyst can pick when
regenerating a single report or story (see
[Relationship to per-artifact selection](#relationship-to-per-artifact-model-selection)).

## Resolution order

When a default model is needed for a customer — for new analyses and for
force-regenerate or summary/detail views that do not name a model
explicitly — it is resolved in this order:

1. **Per-customer override** — a value set for that specific customer.
2. **Admin-set global default** — a single system-wide default set by a
    System Administrator.
3. **Deployment fallback** — the environment defaults
    (`ANALYSIS_DEFAULT_MODEL_NAME` / `ANALYSIS_DEFAULT_MODEL`), which keep
    existing deployments working when neither database tier is set.

The first tier that has a usable value wins. If a stored value is no
longer in the allowed model catalog (for example, a model that was later
removed from the catalog), it is skipped and the next tier is used, so a
stale setting never breaks page loads.

## Permissions

| Setting | Who can view and change it |
| --- | --- |
| **Global default** | System Administrator only. |
| **Per-customer override** | System Administrator (any customer) and an Analyst assigned to that customer. |

Managers and Users can neither view nor change the default analysis
model. Every change records who made it.

## Setting a customer's default model

The per-customer default lives in **Customer Settings**, under
**Default analysis model**. Open Customer Settings while scoped to a
single customer.

1. Choose a model from the **Model** dropdown. The list is the allowed
    model catalog for this deployment.
2. Click **Save**.

The section shows the model currently in effect and where it comes from —
the per-customer override, the global default, or the deployment
fallback.

<!-- Screenshot placeholder: the Customer Settings "Default analysis
model" section, showing the current-source line, the model dropdown, and
the Save / Reset buttons. Capture from a running stack once available
(this surface does not depend on aice-web-next data). -->

### Clearing the override (reset to global)

When a per-customer override is set, a **Reset to global default** button
appears. Clearing the override removes the customer-specific value and
reverts the customer to the global default (or, if no global default is
set, to the deployment fallback).

## Setting the global default

A System Administrator sets the system-wide default from the **Admin →
Settings** page, under **Default analysis model (global)**.

1. Choose a model from the **Model** dropdown.
2. Click **Save**.

Use **Clear global default** to remove it and revert global resolution to
the deployment fallback.

<!-- Screenshot placeholder: the Admin Settings "Default analysis model
(global)" section. Capture from a running stack once available (this
surface does not depend on aice-web-next data). -->

## Invalid values

The setter blocks a model that is not in the allowed catalog: the save is
rejected and the section shows an error rather than storing an unusable
value. As a second safeguard, if a stored value later falls out of the
catalog, resolution skips it and falls back to the next tier instead of
failing.

## What a change affects

Changing a customer's default model affects **future** analyses (and
force-regenerate calls that do not name a model) only. **Existing results
are not changed.**

After a successful change, the page offers to re-analyze the customer's
existing data under the new model. This is an **offer only** — it is never
run automatically, because re-analyzing all existing data is a bounded,
cost-controlled operation that an operator launches deliberately. You can
dismiss the offer; dismissing it changes nothing.

## Default variant and coverage

A report or story is treated as the **default variant** when its model
matches the customer's resolved default. The detail view marks this
variant and uses it as the baseline "default" column in the two-model
compare view, and the coverage indicator is computed against it.

Because the default is now per-customer, this "default variant" decision
follows the same three-tier resolution as everything else: it tracks the
customer's effective default rather than a single deployment-wide value.
The variant the analysis worker seeds as default and the variant the
coverage logic treats as default are always the same one, so they never
disagree about which column is the default.

## Relationship to per-artifact model selection

These two settings coexist as different layers:

- **Per-customer default model (this page)** — the standing model new
    analyses for the customer use by default.
- **Per-artifact selection** — a one-off override when an analyst
    regenerates a single report or story, or runs a two-model compare. It
    does **not** change the customer default.
