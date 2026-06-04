# Analysis Result Page

The analysis result page shows a single LLM analysis of one security event.
It is reached from aice-web-next by opening an event detail and following
the deep link to Clumit Insight, or directly via its customer-scoped URL.

![Analysis result page with priority badge and severity / likelihood scores](../assets/analysis-result.en.png)

## Priority and scores

The header section shows three score-related fields:

- **Priority tier** — one of `CRITICAL`, `HIGH`, `MEDIUM`, or `LOW`. The
  tier is rendered as a colored badge and is derived deterministically
  from the two scores below via a 4×4 matrix lookup; it is not a value
  returned by the LLM.
- **Severity score** — `0.000`–`1.000`, three decimal places. Answers
  "if this event turned out to be a real attack, how bad would it be"
  (impact, blast radius, asset criticality).
- **Likelihood score** — `0.000`–`1.000`, three decimal places. Answers
  "how likely is this actually malicious rather than noise or a false
  positive" (evidence quality, IoC matches, plausible benign
  explanations).

The two axes are kept separate everywhere so that a high-impact but
uncertain event (`severity≈1.0, likelihood≈0.5`) is not flattened into
the same priority as a confirmed but low-impact event
(`severity≈0.5, likelihood≈1.0`). The matrix translates this pair into
one of the four tiers used for triage and aggregation.

### Tier matrix

|              | L < 0.4 | 0.4 ≤ L < 0.6 | 0.6 ≤ L < 0.8 | L ≥ 0.8  |
|--------------|---------|---------------|---------------|----------|
| S ≥ 0.8      | MEDIUM  | HIGH          | CRITICAL      | CRITICAL |
| 0.6 ≤ S < 0.8 | LOW    | MEDIUM        | HIGH          | HIGH     |
| 0.4 ≤ S < 0.6 | LOW    | LOW           | MEDIUM        | MEDIUM   |
| S < 0.4      | LOW    | LOW           | LOW           | LOW      |

## Score factors

Below each score, the page renders up to five short noun phrases (chips)
the LLM produced to articulate that score. Each axis (severity,
likelihood) has its own row of chips.

- Phrases are LLM-generated, capped at five per axis, with a maximum
  length of ~80 characters each.
- When the LLM did not return any usable phrase for an axis — for
  example, because the input event was too thin to support an
  articulation — the chip row shows a single placeholder reading
  `insufficient evidence`. This sentinel value means "the score is
  recorded but no articulation is available", not that the LLM ran
  with no input.

## MITRE ATT&CK techniques

Next to the priority badge, the page renders a row of MITRE ATT&CK
technique chips (e.g. `T1078`, `T1110.001`) that the LLM associated with
the event. Each chip shows the technique ID; hovering reveals the
official technique name as a tooltip (e.g. `T1078` → "Valid Accounts").
A chip whose ID is not in the currently vendored MITRE knowledge base
renders without a tooltip — the underlying analysis row was written
against an older MITRE bundle and the technique ID alone is shown as a
fallback. The chip row is omitted when the LLM returned no techniques.

## Metadata fields

Below the score fields the page shows the analysis metadata in a
two-column grid:

- **Language** — `KOREAN` or `ENGLISH`. Matches the language the analysis
  text was generated in.
- **Provider** — the LLM provider name (e.g. `openai`).
- **Model** — the model id requested (e.g. `gpt-4o`).
- **Model snapshot** — the provider-reported specific model version, if
  the upstream response carried one.
- **Prompt version** — the aimer prompt template version, if reported.
- **Requested by** — the account id that triggered the analysis, as
  stored on the analysis row.
- **Requested at** — when the analysis was requested, shown in your
  timezone with an explicit timezone label. See
  [Account Preferences → Timezone](account-preferences.md#timezone) for
  the resolution order (saved → browser → UTC).

## Pinned evidence version

Opened directly, the page shows the latest analysis for the event. When
reached from a report's [Sources panel](analysis/reports.md#sources), the
link carries a pinned `generation` (plus the language, provider, and
model), and the page loads **exactly that version** — the evidence the
report was built from — rather than the latest re-analysis.

If the pinned version is no longer available — superseded by a newer
generation or removed by retention — the page shows a **"This evidence
version is no longer available"** notice instead of silently falling back
to the latest analysis, so a Sources link can never misrepresent a newer
version as the one the report cited.

## Analysis body

The body shows the LLM analysis text with PII tokens already restored
to their original values. The analysis is Markdown, and the page renders
it as formatted output — headings, bullet and numbered lists, and inline
code spans appear as styled elements rather than raw `#`, `-`, or
backtick characters. Raw HTML embedded in the text is never rendered as
live markup; it is treated as inert text, since the body is
LLM-generated.

Any `<<UNVERIFIED_IP_...>>` / `<<UNVERIFIED_EMAIL_...>>` /
`<<UNVERIFIED_MAC_...>>` markers — entities the LLM emitted that were
not present in the original event — are rendered as red pill badges so
they stand out from the rest of the analysis, even when they appear
inside a list item or heading.

## Part of threat stories

When this suspicious event is a member of one or more threat stories, the
page shows a **Part of threat story / stories** section near the top with
a link to each parent story (with its priority-tier badge). This is the
upward half of the trust drill-down: a reader who arrived at the event
can navigate back up to the correlation it belongs to. The membership is
resolved by a reverse lookup over each story's member list, so it stays
in sync as stories are re-analysed. Because a story's membership can
change from one re-analysis generation to the next, each backlink opens
the **exact story generation whose member list contains this event** — it
does not blindly jump to the latest generation, which might have
regrouped the event out. The section is omitted when the event is not a
member of any story.

<!-- Screenshot placeholder (#396): event page with the "Part of threat
stories" backlink. Capture from a stack with real story-member data. -->

## Cited by

If one or more periodic reports cite this event, the page shows a **Cited
by** trail listing those reports, newest first. Each entry links back up
to the **exact report generation** that consumed this event — the link is
generation-pinned, so it lands on the version the report was built from,
not the latest. The trail is also scoped to the **evidence generation you
are viewing**: it lists the reports that cited *this* generation of the
event, so arriving at an older pinned generation (via a report's Sources
link) shows the reports that cited that generation, not ones that cited a
different one. A single event may be cited by reports across several
periods; the trail lists one entry per report bucket. An event cited by
no report shows no trail (this is a normal state, not an error).

The trail is permission-gated: it only appears for viewers who can read
the customer's reports (`reports:read`). A viewer without that permission
sees no trail rather than links they could not open.

<!-- Screenshot placeholder (#396): event page with the "Cited by" trail.
Capture from a stack with real report-citation data. -->

## Raw source event

The raw source event is the bottom of the trust chain. aimer-web does not
store raw event payloads — only the (tokenized) analysis — so this final
hop is an **external link to the aice-web-next source event**. When the
source event is still present, the page shows a **View source event in
aice-web-next** link alongside the force-re-run action.

When the source has been swept by retention (see the retention banner
below), the chain ends gracefully at the preserved analysis: the
raw-event link is **not** rendered, so a reader never follows a dead
link. The retention banner makes the end-of-chain state explicit.

## Retention banner

If the source `detection_events` row has been removed by retention but
the analysis row survives, the page shows a yellow banner reading
"Source event removed by retention; analysis result preserved." Both the
"View source event" hop and the "Force re-run" button are hidden in this
state: the raw event no longer exists to link to, and force re-run
requires the original event payload, which only aice-web-next holds.

## Force re-run

When the source event is still present, the page shows a "Force re-run
in aice-web-next" link. Clicking it opens aice-web-next at the original
event detail with a query parameter that tells aice-web-next to send
`force=true` on the next analyze click, bypassing the cached result.
Unlike the **View source event** hop above — a plain read-only link to
the source event — this link carries the re-run signal.
