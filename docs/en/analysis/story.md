# Story Analysis Page

The story analysis page shows a single LLM analysis of a multi-event
story — the unit that aice-web-next groups related detection events into
before deeper review. Each story is analysed once per default
`(language, provider, model)` variant by a background worker; the page
renders the latest non-superseded result.

The page is reached from aice-web-next by opening a story detail and
following the deep link to aimer-web, or directly via the
customer-scoped URL:

```
/customers/{customerId}/analysis/story/{storyId}
```

The customer id appears in the path because story ids are only unique
within a customer. Opening a story-scoped URL without the customer
segment would resolve to the wrong story when the tab's selected
customer differs from the story's owner.

![Story analysis page with priority badge, factor chips, and TTP chips](../assets/story-detail.en.png)

## How a story enters analysis

The worker pipeline runs the following stages without operator action:

1. As Phase 2 ingest writes story member events for a customer, the
   `story_analysis_state` row tracks readiness. It promotes from
   `pending` to `ready` once the story has been idle for the configured
   quiet window or once the maximum wait has elapsed (see the
   configuration page for `ANALYSIS_STORY_IDLE_MINUTES` /
   `ANALYSIS_STORY_MAX_WAIT_HOURS`).
2. The dispatcher seeds a real `story_analysis_job` row for the default
   variant against every `ready` or `dirty` state row that lacks one,
   then picks `queued` rows with `FOR UPDATE SKIP LOCKED`, advisory-
   locked per `(customer_id, story_id)`.
3. The worker reads the canonical story version's members (latest
   `received_at`), rewrites event-scope redaction tokens to
   story-scope tokens (`<<REDACTED_*_E{i}_*>>`), and calls aimer's
   `analyzeStory` mutation under mTLS as `system:analysis-worker`.
4. The response is validated (MITRE technique IDs filtered against the
   vendored ATT&CK set, factor chips shape-filtered and capped at five,
   hallucination scan against the LLM narrative) and written to
   `story_analysis_result`. The auth-DB job row is then finalized to
   `status='done'`.

Retryable failures (5xx, transport, mTLS error) re-queue with
exponential backoff up to `ANALYSIS_MAX_ATTEMPTS`. Fatal failures (4xx,
hallucination detected, mixed or missing redaction policy versions)
mark the job `failed` immediately.

## Priority and scores

The header section shows three score-related fields:

- **Priority tier** — one of `CRITICAL`, `HIGH`, `MEDIUM`, or `LOW`. The
  tier is rendered as a colored badge and is derived deterministically
  from the two scores below via a 4×4 matrix lookup, not returned by the
  LLM.
- **Severity score** — `0.000`–`1.000`, three decimal places. Answers
  "if this story turned out to be a real attack, how bad would it be".
- **Likelihood score** — `0.000`–`1.000`, three decimal places. Answers
  "how likely is this actually malicious rather than noise". The stored
  value is the raw LLM estimate; floors (e.g. five-or-more members
  raises effective likelihood to `≥ 0.7` before the matrix lookup) are
  applied at tier derivation only, so calibration data and the floor
  policy stay revisable without rewriting history.

### Tier matrix

|              | L < 0.4 | 0.4 ≤ L < 0.6 | 0.6 ≤ L < 0.8 | L ≥ 0.8  |
|--------------|---------|---------------|---------------|----------|
| S ≥ 0.8      | MEDIUM  | HIGH          | CRITICAL      | CRITICAL |
| 0.6 ≤ S < 0.8 | LOW    | MEDIUM        | HIGH          | HIGH     |
| 0.4 ≤ S < 0.6 | LOW    | LOW           | MEDIUM        | MEDIUM   |
| S < 0.4      | LOW    | LOW           | LOW           | LOW      |

## Score factors

Below each score, the page renders up to five short noun phrases (chips)
the LLM produced to articulate that score. Each axis has its own chip
row.

- Phrases are LLM-generated, capped at five per axis, with a maximum
  length of ~80 characters each.
- When the LLM did not return any usable phrase for an axis — for
  example, because the input members were too thin to support an
  articulation — the chip row shows a single placeholder reading
  `insufficient evidence`. This sentinel means "the score is recorded
  but no articulation is available", not that the LLM ran with no
  input.

## MITRE ATT&CK techniques

Next to the priority badge, the page renders a row of MITRE ATT&CK
technique chips (e.g. `T1078`, `T1110.001`) that the LLM associated
with the story. Each chip shows the technique ID; hovering reveals the
official technique name as a tooltip (e.g. `T1078` → "Valid
Accounts"). A chip whose ID is not in the currently vendored MITRE
knowledge base renders without a tooltip — the underlying analysis row
was written against an older MITRE bundle and the ID alone is shown as
a fallback. The chip row is omitted when the LLM returned no
techniques.

## Metadata fields

Below the score fields the page shows the analysis metadata in a
two-column grid:

- **Language** — `KOREAN` or `ENGLISH`.
- **Provider** — the LLM provider name (e.g. `openai`).
- **Model** — the model id requested (e.g. `gpt-4o`).
- **Model snapshot** — the provider-reported specific model version.
- **Prompt version** — the aimer prompt template version.
- **Requested by** — the account id that triggered the latest
  generation, or `system` if the analysis was produced by the regular
  worker tick rather than a force-regenerate.
- **Requested at** — ISO 8601 timestamp of the request.

## Analysis body

The body shows the LLM analysis narrative with story-scope tokens
(`<<REDACTED_*_E{i}_*>>`) preserved verbatim. The token namespacing
prevents the LLM from accidentally merging entities across member
events; the analyst UI keeps the tokens visible rather than
substituting back to plaintext, which makes residual unmapped tokens
(a hallucination signal) easy to spot. A hallucinated decode is
blocked at write time and never reaches this view.

## Force regenerate

Operators with `analyses:configure` can rerun the analysis manually via
the **Regenerate** button at the bottom of the page.

![Confirmation modal explaining the cost of a regenerate request](../assets/story-regenerate-modal.en.png)

The confirmation modal explicitly mentions that a fresh LLM call is
issued and the latest generation is superseded once the new result
lands. The previous result row is preserved with a `superseded_at`
stamp; nothing is overwritten in place.

Submitting the modal calls
`POST /api/customers/{customerId}/analysis/story/{storyId}/regenerate`
(optionally with `?lang=&model_name=&model=` to target a non-default
variant). Behaviour:

- The job row's `generation` is bumped by one (or `1` if no prior row
  for the variant exists), `status` resets to `queued`, `attempts` resets
  to `0`, and the LLM call begins on the next worker tick.
- Bridge sessions and accounts without `analyses:configure` are
  rejected with `403`.
- An archived state row or a story without a surviving canonical
  version returns `409 source_unavailable`; an unknown story returns
  `404 story_not_found`. The endpoint rejects `?tz=…` with `400
  invalid_param` because story analysis is timezone-independent, and
  rejects any `lang` other than `KOREAN` / `ENGLISH` with the same
  error.

While the regenerate is queued, the page shows a yellow status banner
naming the new generation number. Refresh the page once the worker has
written the new result.

## Cross-system deep link

aice-web-next consumes the matching summary endpoint to decide whether
to expose a deep link badge for a story:

```
GET /api/customers/{customerId}/analysis/story/{storyId}/summary
```

The endpoint returns either `{exists: false}` (no analysis has been
produced yet) or a small content-free payload with `priority_tier`, the
two scores, `score_kind: "leaf"`, and a `link` to this page. TTP tags
and factors are content, not surface metadata, and stay out of the
summary so the aice-web-next badge cannot leak details of the
analysis. To filter stories by TTP, use the aimer-web overview list at
`/analysis` rather than the badge.

![aice-web-next badge consuming the story summary endpoint](../assets/story-summary-badge.en.png)
