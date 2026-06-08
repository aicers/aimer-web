# RFC 0002: Periodic LLM analysis for stories, baselines, and time-windowed reports

- Status: **Accepted** — core delivered 2026-06-08 (see Decision log closing notice)
- Authors: @sehkone
- Tracks: [#292](https://github.com/aicers/aimer-web/issues/292)
- Depends on: RFC 0001 (analysis storage, redaction)
- Server-side counterpart: aimer (new mutations `analyzeStory`, `generatePeriodicSecurityReport`, exposed on auth-mtls only and stateless on the aimer side)
- Sender-side counterpart: aice-web-next (optional `cursor_event_time` watermark on Phase 2 envelopes; deep-link entry points)

## Summary

RFC 0001 covers the single-event analysis path (`analyzeEvent` per `detection_events` row). This RFC extends LLM analysis to two new units:

1. **Story-level analysis** — one LLM call per `story` (the pre-curated narrative of multiple correlated events), not per `story_member`.
2. **Periodic security reports** — LIVE (rolling N hours), DAILY, WEEKLY, MONTHLY summaries that fuse story analyses, single-event analyses, and baseline aggregates into one report per customer per bucket.

Baseline events are **never** analyzed individually; they enter periodic reports only as aggregated statistics.

All LLM input is drawn from columns covered by RFC 0001's event-level redaction map (`(aice_id, event_key)`). Aggregate-level JSONB columns that are out of scope for v1 redaction — notably `story.summary_payload` and `policy_run.summary_stats` — are **not sent to the LLM** in this RFC's scope. Story-level analysis input is built strictly from redacted `story_member.event` content plus story metadata that carries no PII (e.g., story id, time range, member count, role distribution). A story-level redaction map is left as future work; see §"Redaction stance".

All LLM-bound work is scheduled by background workers in aimer-web. aice-web-next continues to be the operator's investigative workspace and gains deep links into aimer-web for the new artifacts; the *full* AI feature set lives in aimer-web.

## Motivation

- Per-event analysis alone has two gaps: narrative context is lost (story_member events analyzed in isolation lose the kill-chain signal), and there is no time-windowed digest for operators who want "what happened today / this week / right now."
- aimer already supports `generateReport(DAILY/WEEKLY/MONTHLY)`, but it builds reports purely from previously-analyzed single events. Phase 2 ingestion (baseline, story) does not pass through single-event analysis (cost-prohibitive), so today's `generateReport` has nothing to summarize on the Phase 2 side.
- A LIVE (intra-day) layer is needed for the "what is happening right now" use case that a DAILY-only cadence cannot serve.
- Operators must be able to force-regenerate any result, see priority-graded highlights without noise, and trust day/week/month boundaries against a stable timezone.

## Scope and non-goals

In scope:

- New aimer mutations: `analyzeStory`, `generatePeriodicSecurityReport(period, date, timezone, ...)`, exposed on **auth-mtls only** and **stateless on the aimer side**.
- Single-customer timezone column owned by aimer-web. aimer itself stores nothing for this RFC; it only renders time strings in the supplied timezone inside prompt output.
- aimer-web background worker for story and periodic report generation; force-regenerate API; priority tiering; dedup; readiness/settle/dirty state machine; **sole holder of analysis results and cache**.
- aice-web-next: optional `cursor_event_time` watermark on Phase 2 envelopes; deep links into aimer-web for the surfaces defined in §"Cross-project surfaces".

Out of scope (deferred or separate):

- Policy event / policy run analysis. (Phase out — same machinery can be reused later but no design here.)
- Translation-based multi-language outputs (currently each language is a separate LLM call; revisit in Phase 4).
- Real-time streaming (websocket/SSE) push to the operator UI. UI polls or uses standard refresh in v1.
- Account-level timezone for boundary calculation (account.timezone stays UI-display-only; boundaries are customer-level).
- **Any modification of the existing auth-jwt GraphQL surface in aimer.** auth-jwt code may be reused as in-process helpers (LLM client, prompt loader, redaction utilities) but the JWT mutations / queries themselves are not changed by this RFC. The auth-jwt surface will be removed wholesale in a future effort outside this RFC.

---

## Cross-project responsibility model

Three repositories cooperate:

| Project | Role |
|---|---|
| **aimer** (Rust daemon) | Owns the LLM. **For this RFC, exposes new mutations on auth-mtls only and stores nothing** — every new mutation is stateless. The pre-existing auth-jwt surface and its caches remain untouched (deletion deferred to a separate effort). Knows nothing about story/baseline domain semantics beyond what the prompt input describes. |
| **aimer-web** (Next.js BFF) | Owns the full AI feature surface. Schedules background analysis, stores results, applies redaction, computes priority tiers, dedups across Phase 1/Phase 2, enforces force-regenerate, surfaces full UI. **All AI features live here.** |
| **aice-web-next** | Owns event ingestion (Phase 1 bridge + Phase 2 push). Surfaces deep links into aimer-web at narrowly-defined points (see below). Does **not** host AI analysis UI itself. |

### What lives **only** in aimer-web

The rule: if a feature requires reading AI analysis results, configuring how analysis runs, or operating on history, it lives in aimer-web.

- Full report viewer (LIVE / DAILY / WEEKLY / MONTHLY)
- Full story analysis viewer
- Force-regenerate controls and the resulting confirmation/history UI
- Priority threshold configuration (admin)
- Customer timezone configuration (admin)
- Generation history (re-analysis trail, who/when/why)
- LLM cost & quality dashboards
- Listing / filtering / search across all analyses
- Multi-language toggle and re-generation in other languages

### What aice-web-next surfaces (deep-link only)

aice-web-next must remain the operator's primary investigative tool. Where the operator is already looking at an entity for which aimer-web has an analysis, a single badge/link is shown. The link opens aimer-web in a new tab or panel; aice-web-next does not embed or render the analysis content itself.

The criteria for "important enough to surface":

1. **Contextual relevance**: the operator is viewing an entity (single event, story, baseline cluster, customer dashboard) whose AI analysis directly explains what they are looking at.
2. **Priority threshold**: only `HIGH` and `CRITICAL` results surface as visible badges. `MEDIUM`/`LOW` may be reachable through an explicit "show all analyses" link, never as a default-visible badge.
3. **Recency for the front page**: the customer dashboard surfaces only LIVE and today's DAILY summary card. Weekly/monthly are reachable via "Open in aimer-web" only.

The specific deep-link surfaces (v1):

| aice-web-next location | Surface | Links to (aimer-web) |
|---|---|---|
| Event detail page (Phase 1 detection) | "AI analysis" badge if result exists, with priority tier | `/analysis/event/{aice_id}/{event_key}` |
| Story detail page | "AI narrative analysis" badge with priority tier | `/customers/{customer_id}/analysis/story/{story_id}` |
| Customer dashboard | "Latest security digest" card showing LIVE summary headline | `/analysis/reports/live` |
| Customer dashboard | "Today's report" card showing DAILY top-1 highlight | `/analysis/reports/daily/{date}` |
| Global nav (top bar) | "Open AI analyses →" link | `/analysis` (overview) |

Everything else (weekly/monthly, story listings filtered by priority, baseline drift charts, force-regenerate, settings) is reachable **only inside aimer-web**.

### Decision rule for future features

When a new AI feature is proposed, apply this checklist:

1. Does it primarily *produce or operate on* AI analysis state (configuration, regeneration, history)? → **aimer-web only**.
2. Does it primarily *consume* a single AI result while the operator is looking at the corresponding source entity? → deep-link badge in aice-web-next + full view in aimer-web.
3. Does the operator need to switch context away from their current investigation to view it? → **aimer-web only**, do not surface in aice-web-next.

If a feature both produces and consumes (e.g., feedback button), it lives in aimer-web. aice-web-next may carry a "give feedback" link but not the feedback UI itself.

---

## Architecture overview

```
                            ┌──────────────────┐
                            │  aice-web-next   │
                            │  (sender + ops UI│
                            │   with deep links│
                            │   to aimer-web)  │
                            └──┬───────────────┘
                               │  Phase 1: analyze-bridge (multipart, JWS)
                               │  Phase 2: baseline/story/policy batches
                               │  (optional) cursor_event_time watermark
                               ▼
                      ┌─────────────────────┐
                      │     aimer-web       │
                      │  ┌────────────────┐ │
                      │  │ ingest routes  │ │
                      │  └─────┬──────────┘ │
                      │        │ writes     │
                      │  ┌─────▼──────────┐ │
                      │  │ customer DB    │ │
                      │  │  detection_*   │ │
                      │  │  baseline_*    │ │
                      │  │  story_*       │ │
                      │  │  *_analysis_*  │ │   (new)
                      │  └─────┬──────────┘ │
                      │        │ ready?     │
                      │  ┌─────▼──────────┐ │
                      │  │ analysis-job-  │ │   (new worker)
                      │  │ worker         │ │
                      │  └─────┬──────────┘ │
                      └────────┼────────────┘
                               │ mTLS GraphQL
                               ▼
                      ┌─────────────────────┐
                      │       aimer         │
                      │  analyzeEvent       │
                      │  (existing)         │
                      │  analyzeStory   (new)│
                      │  generatePeriodic-  │
                      │  SecurityReport(new)│
                      │  new mutations:     │
                      │  auth-mtls only,    │
                      │  stateless          │
                      └─────────────────────┘
```

---

## Customer-level timezone

### Decision

Day/week/month boundaries used by aimer-web schedulers and aimer report inputs are computed from a **customer-level** timezone. Account-level `timezone` (on `accounts`) is retained for UI display only and never participates in boundary calculation or cache keying.

### Why customer, not account

- Two operators in the same customer must see "yesterday's report" mean the same window.
- A periodic report's `bucket_date` is a property of the data, not the viewer.
- Caches stay single-keyed per customer instead of fanning out per user.

### Implementation

- **aimer-web** [migration]: `ALTER TABLE customers ADD COLUMN timezone TEXT NOT NULL DEFAULT 'Asia/Seoul';`
- **aimer-web** [admin UI]: customer settings page exposes a timezone selector (IANA names via `Intl.supportedValuesOf("timeZone")`); change is gated by an admin permission and shows a confirmation modal.
- **aimer-web** [lifecycle on tz change]: `tz` is part of the `periodic_report_state`, `periodic_report_job`, and `periodic_report_result` PKs, so a timezone change does **not** mutate existing rows. Instead:
  - New `periodic_report_state` rows for the new tz are created lazily on the next worker tick as their dates become ready; variant jobs follow.
  - All existing `done` result rows for the customer with `tz != new_tz` are marked `superseded_at = NOW()` (visible only via history; hidden from default UI).
  - Old `periodic_report_state` rows with `tz != new_tz` are moved to terminal status `archived` (no further regeneration). Their underlying `periodic_report_job` rows are left as-is (no new work will be scheduled because the parent state is archived). Reactivation is manual (admin tool) if the customer reverts.
  - `story_analysis_state` / `story_analysis_job` rows are unaffected (no calendar boundary).
- **aimer** [new mutations only]: `generatePeriodicSecurityReport` takes `timezone: String!` and uses it strictly for rendering time strings inside the prompt — there is no aimer-side cache for it, so timezone is not a cache key. `analyzeStory` does **not** take `timezone` — story analysis output is UTC and timezone is an aimer-web render-time concern. The pre-existing auth-jwt `generateReport` and its `ReportKey` are **not** modified by this RFC (they will be deleted with the rest of the auth-jwt surface in a separate effort).
- **aice-web-next**: no change required. Deep links into aimer-web do not need to carry timezone; aimer-web resolves from the customer.

### Account-level timezone (existing)

- aice-web-next already supports it (preferences page).
- aimer-web stores `accounts.timezone` but lacks a change UI; gap is acknowledged but **out of scope** for this RFC (filed as a separate small task).

---

## Redaction stance

RFC 0001 establishes that the redaction map is keyed by `(aice_id, event_key)` and that aggregate-level JSONB columns (`story.summary_payload`, `policy_run.summary_stats`) are **not** in v1's redaction scope. This RFC inherits that boundary.

Concrete rules for what is allowed into the LLM in this RFC:

- **Allowed**: redacted `story_member.event` JSONB, redacted `detection_events.redacted_event` JSONB, baseline **aggregate statistics** (counts, distributions, deltas — derived from `baseline_event` columns but stripped of raw payloads).
- **Allowed (non-PII metadata)**: story id, story time range, story member count and role distribution, period and date, customer-level config such as timezone.
- **Disallowed**: `story.summary_payload` raw content, `policy_run.summary_stats` raw content, any raw `baseline_event.raw_event` or `baseline_event.window_signals`, any other column not covered by the event-level redaction map.

The story analysis prompt (`STORY_PROMPT`) is built strictly from the allowed list. If, during a generation, no allowed input remains (e.g., all members redacted away), the worker writes an explicit "insufficient input" result rather than calling the LLM.

### Token namespacing for multi-event LLM inputs

RFC 0001's redaction tokens are **scoped per event**: each `(aice_id, event_key)` map issues independent identifiers like `<<REDACTED_IP_001>>`. When a single LLM call combines multiple events (story analysis, periodic report), naive concatenation collides — `<<REDACTED_IP_001>>` from event A and event B become indistinguishable, and the LLM output cannot be unambiguously demapped.

aimer-web resolves this **at prompt-build time** with a deterministic token rewrite. No new encrypted map is introduced; the per-event maps remain the sole source of truth.

> Scope: this statement is about **event-token (`E{i}`) namespacing** — the only token source in RFC 0002 itself. RFC 0001 Amendment A later adds a separate fact-token namespace (`F{k}`) for external-TI enrichment facts, whose source of truth is the `enrichment_redaction_map` (resolved via `input_fact_refs`), not the per-event maps. The two namespaces are disjoint and demap through their own refs; "no new map" holds for the event-namespacing mechanism described here, while `F{k}` is governed by Amendment A.

Procedure:

1. The worker assigns each included event an ordinal index `i` (1, 2, 3, ...) in a fixed order — for story analysis: by `(member_event_key)` ascending; for periodic reports: by `(aice_id, event_key)` ascending.
2. When rendering an event's redacted text into the prompt, every token of the form `<<REDACTED_{TYPE}_{NNN}>>` is rewritten to `<<REDACTED_{TYPE}_E{i}_{NNN}>>`. The `E{i}` infix is the scope-unique segment.
3. The prompt asks the LLM to preserve these tokens verbatim in its output. The `STORY_PROMPT` / `PERIODIC_SECURITY_REPORT_PROMPT` carry an explicit instruction to that effect.
4. The ordered event list — `input_event_refs JSONB` — is stored on the result row.
5. To render plaintext to a user: parse `<<REDACTED_{TYPE}_E{i}_{NNN}>>` in `analysis_text`, look up index `i` in `input_event_refs` to get `(aice_id, event_key)`, then decrypt that event's redaction map and resolve `<<REDACTED_{TYPE}_{NNN}>>` to the original value. Existing RFC 0001 decryption infrastructure is reused unchanged.

Consequences:

- Per-event maps stay immutable. The combined "scope" exists only at prompt-build and render time.
- `input_event_refs` is small (tens of `(aice_id, event_key)` pairs) and is part of the canonical input that `input_hash` is computed over.
- If an event is later subjected to retention sweep before the analysis is read, its tokens become unresolvable. UI renders these as a placeholder ("event purged by retention") rather than failing the page.
- Default UI never displays raw tokens to users; RFC 0001's "UI never shows tokens" principle is preserved.

### Report-scope rewrite (when reports consume story/event analyses)

A periodic report's LLM input is `{story_analyses, event_analyses, baseline_aggregates}`. The included `story_analyses[*].analysis_text` and `event_analyses[*].analysis_text` already contain story-scope or event-scope tokens (`<<REDACTED_TYPE_E{i}_NNN>>` or `<<REDACTED_TYPE_{NNN}>>` respectively). Concatenating multiple story analyses into one report prompt collides their `E{i}` indices.

The report input builder applies a second namespacing pass, **report-scope**, with a distinct prefix letter to keep the layer visible in tokens and logs:

1. Union the `input_event_refs` of every included story analysis and every included event analysis into a single ordered list, deduplicated by `(aice_id, event_key)`. This becomes the **report's** `input_event_refs`.
2. For each included `story_analysis_result.analysis_text`, rewrite every `<<REDACTED_TYPE_E{i}_NNN>>` token by:
   - resolving `E{i}` → `(aice_id, event_key)` via that source row's own `input_event_refs`,
   - finding the new index `j` of that `(aice_id, event_key)` in the report's merged `input_event_refs`,
   - rewriting to `<<REDACTED_TYPE_R{j}_NNN>>`.
3. For each included `event_analysis_result.analysis_text`, rewrite every `<<REDACTED_TYPE_NNN>>` to `<<REDACTED_TYPE_R{j}_NNN>>` where `j` is the event's index in the report's merged refs.
4. Baseline aggregates carry no tokens (they are statistics).
5. The rewritten texts are what the report prompt actually sees. The report's `analysis_text` (in `periodic_report_result.sections_jsonb`) is rendered by the LLM using the `R{j}` prefix; demap on display follows the same chain as story-scope, just one indirection deeper at index resolution.

The choice of distinct prefix letters (`E` for story-scope, `R` for report-scope) is a debugging convenience — operators reading raw prompts or analysis text can tell at a glance which namespacing layer they are looking at. The runtime depends only on the fact that the prefix uniquely identifies the index list to consult.

If, in the future, reports cite other reports (weekly citing daily), the same pattern recurses: another scope letter, another input_event_refs merge. The mechanism does not need redesign for that case.

> **Round 14 note (cross-model coverage).** A default report's merged `input_event_refs` / `input_story_refs` may now include leaves analyzed under a *fallback* model (§"Leaf selection: coverage vs calibration"). The `R{j}` namespacing **scheme** is unchanged — each leaf still resolves through its own per-event redaction map — but every reader that previously pinned all refs to the *report row's* `(model_name, model)` must instead pin each leaf by **its own ref's** model (with row-model fallback for legacy refs that predate the per-leaf field): leaf/token restore, citation-variant resolution, and the reverse "Cited by" containment probe. Token namespacing stays orthogonal to leaf-model selection — the rewrite operates on token text — but the *lookup* of which leaf a ref points at is now per-ref, not per-row.

**Future work** (out of scope for this RFC, tracked separately):

- A story-level redaction map (`story_summary_redaction_map`, keyed by `story_id`) that would let `summary_payload` be included safely. This requires extending the redaction engine to support multi-key map scopes and is a non-trivial RFC of its own. Until then, the deliberate exclusion above stands.

---

## Data model additions (aimer-web, customer DB)

### `story_analysis_result`

Stores LLM output for a single story.

```sql
CREATE TABLE story_analysis_result (
  customer_id              UUID         NOT NULL,
  story_id                 BIGINT       NOT NULL,
  lang                     TEXT         NOT NULL,
  model_name               TEXT         NOT NULL,
  model                    TEXT         NOT NULL,         -- requested model id
  model_actual_version     TEXT         NOT NULL,         -- as reported by the provider (e.g. snapshot id)
  prompt_version           TEXT         NOT NULL,         -- aimer-side prompt revision tag
  generation               INT          NOT NULL,
  severity_score           DOUBLE PRECISION NOT NULL,     -- 0.0–1.0; "if real, how bad" (impact, blast radius)
  likelihood_score         DOUBLE PRECISION NOT NULL,     -- 0.0–1.0; "how likely this is a real threat" (evidence quality)
  severity_factors         JSONB        NOT NULL DEFAULT '[]',    -- array of short noun phrases articulating severity_score, ordered most impactful first; see §"Score factor articulation"
  likelihood_factors       JSONB        NOT NULL DEFAULT '[]',    -- same shape, articulating likelihood_score
  ttp_tags                 JSONB        NOT NULL DEFAULT '[]',    -- array of validated MITRE ATT&CK technique IDs (e.g. ["T1078", "T1110.001"]); see §"MITRE ATT&CK TTP tagging"
  priority_tier            TEXT         NOT NULL,         -- CRITICAL|HIGH|MEDIUM|LOW; derived from (severity, likelihood) matrix
  analysis_text            TEXT         NOT NULL,
  input_event_refs         JSONB        NOT NULL,         -- ordered [{aice_id, event_key}, ...] for E{i} token namespacing demap
  input_fact_refs          JSONB        NOT NULL DEFAULT '[]', -- ordered [enrichment-row id, ...] for F{k} fact-scope demap (RFC 0001 Amendment A); empty when no enrichment facts carried customer-asset tokens
  input_hash               TEXT         NOT NULL,         -- sha256 of the canonical LLM input (members + metadata + event refs + fact refs)
  redaction_policy_version TEXT         NOT NULL,
  requested_by             UUID,
  requested_at             TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  superseded_at            TIMESTAMPTZ,
  PRIMARY KEY (customer_id, story_id, lang, model_name, model, generation)
);
```

`input_hash`, `prompt_version`, and `model_actual_version` exist to detect drift: if the same `(customer_id, story_id)` produces visibly different outputs across runs, operators can attribute the change to prompt/model/input rather than guessing.

### `periodic_report_result`

Stores LLM output for one (customer, period, bucket_date, tz).

```sql
CREATE TABLE periodic_report_result (
  customer_id              UUID         NOT NULL,
  period                   TEXT         NOT NULL,         -- LIVE|DAILY|WEEKLY|MONTHLY
  bucket_date              DATE         NOT NULL,         -- LIVE uses a synthetic date or epoch
  tz                       TEXT         NOT NULL,         -- snapshot of customer.timezone at generation
  lang                     TEXT         NOT NULL,
  model_name               TEXT         NOT NULL,
  model                    TEXT         NOT NULL,
  model_actual_version     TEXT         NOT NULL,
  prompt_version           TEXT         NOT NULL,
  generation               INT          NOT NULL,
  aggregate_severity_score   DOUBLE PRECISION NOT NULL,   -- informational; max over report-model leaf severities + baseline drift severity (NOT a priority_tier input); report-model subset per round 14
  aggregate_likelihood_score DOUBLE PRECISION NOT NULL,   -- informational; max over report-model leaf likelihoods + baseline drift likelihood (NOT a priority_tier input); report-model subset per round 14
  aggregate_ttp_tags       JSONB        NOT NULL DEFAULT '[]',    -- union of all selected leaf ttp_tags (full selected set, NOT the report-model calibration subset — TTP tags are coverage facets, not scores), deduplicated and sorted; see §"MITRE ATT&CK TTP tagging" and §"Priority tiering" round 14
  priority_tier            TEXT         NOT NULL,         -- derived as max(report-model leaf priority_tiers, matrix(baseline_drift_severity, baseline_drift_likelihood)); coverage vs calibration split (round 14), see §"Priority tiering"
  sections_jsonb           JSONB        NOT NULL,         -- aimer's PERIODIC_SECURITY_REPORT shape: {executive_summary (string), story_highlights (array), notable_events (array), baseline_observations (array), period_outlook (string)}; array sections joined for display, see §"Verification gate"
  input_event_refs         JSONB        NOT NULL,         -- ordered [{aice_id, event_key, model_name, model}, ...] for token namespacing demap; per-leaf model added round 14 (cross-model coverage; refs lacking it read back as the report's model)
  input_story_refs         JSONB        NOT NULL,         -- ordered [{story_id, model_name, model}, ...] for citation backlinks; per-leaf model added round 14
  input_hash               TEXT         NOT NULL,         -- sha256 over the canonical input bundle (refs included)
  input_watermark          TIMESTAMPTZ,                   -- snapshot of cursor_watermark used at generation, if any
  redaction_policy_version TEXT         NOT NULL,
  requested_by             UUID,
  requested_at             TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  superseded_at            TIMESTAMPTZ,
  PRIMARY KEY (customer_id, period, bucket_date, tz, lang, model_name, model, generation)
);
```

`aggregate_severity_score` and `aggregate_likelihood_score` are computed at write time (see §"Priority tiering"). `input_watermark` records the upstream cursor that was treated as "complete enough" for this generation; refresh-window arrivals past this watermark are the trigger to mark `dirty`.

### Source state and per-variant jobs (auth DB)

State is split into two layers because **source data readiness** (is the underlying ingest done enough to analyze?) is shared across all output variants of a given source, while **variant-job work** (is this lang/model copy queued / processing / done?) is per-variant. Forcing Korean to regenerate while leaving the English copy alone — or pushing a third language — must not conflict with sibling variants.

#### Story

```sql
-- One row per story. Tracks source-side readiness only.
CREATE TABLE story_analysis_state (
  customer_id           UUID NOT NULL,
  story_id              BIGINT NOT NULL,
  status                TEXT NOT NULL,                  -- pending|ready|dirty|archived
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  first_member_at       TIMESTAMPTZ,                    -- set on first member ingest; never updated thereafter
  last_member_at        TIMESTAMPTZ,                    -- updated on every subsequent ingest
  last_ready_at         TIMESTAMPTZ,                    -- when the worker last flipped pending|dirty -> ready
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (customer_id, story_id)
);

-- One row per (story, lang, model_name, model). Tracks per-variant work.
CREATE TABLE story_analysis_job (
  customer_id           UUID NOT NULL,
  story_id              BIGINT NOT NULL,
  lang                  TEXT NOT NULL,
  model_name            TEXT NOT NULL,
  model                 TEXT NOT NULL,
  status                TEXT NOT NULL,                  -- queued|processing|done|failed
  generation            INT  NOT NULL DEFAULT 1,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processing_started_at TIMESTAMPTZ,                    -- set on queued -> processing
  last_generated_at     TIMESTAMPTZ,                    -- set on processing -> done
  force_requested_at    TIMESTAMPTZ,
  force_requested_by    UUID,
  attempts              INT  NOT NULL DEFAULT 0,
  last_error            TEXT,
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (customer_id, story_id, lang, model_name, model),
  FOREIGN KEY (customer_id, story_id)
    REFERENCES story_analysis_state(customer_id, story_id)
);
```

#### Periodic report

```sql
-- One row per (customer, period, bucket_date, tz). Tracks source-side readiness only.
CREATE TABLE periodic_report_state (
  customer_id           UUID NOT NULL,
  period                TEXT NOT NULL,                  -- LIVE|DAILY|WEEKLY|MONTHLY
  bucket_date           DATE NOT NULL,                  -- LIVE uses a synthetic date or epoch
  tz                    TEXT NOT NULL,                  -- snapshot of customer.timezone at bucket creation
  status                TEXT NOT NULL,                  -- pending|ready|dirty|archived
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_event_at         TIMESTAMPTZ,                    -- most recent ingest that fell into this bucket's range
  cursor_watermark      TIMESTAMPTZ,                    -- from aice-web-next, if available
  cursor_watermark_quality TEXT,                        -- 'strict' | 'soft' (#295); strict is required to shorten DAILY settle
  last_ready_at         TIMESTAMPTZ,
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (customer_id, period, bucket_date, tz)
);

-- One row per (bucket, lang, model_name, model). Tracks per-variant work.
CREATE TABLE periodic_report_job (
  customer_id           UUID NOT NULL,
  period                TEXT NOT NULL,
  bucket_date           DATE NOT NULL,
  tz                    TEXT NOT NULL,
  lang                  TEXT NOT NULL,
  model_name            TEXT NOT NULL,
  model                 TEXT NOT NULL,
  status                TEXT NOT NULL,                  -- queued|processing|done|failed
  generation            INT  NOT NULL DEFAULT 1,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processing_started_at TIMESTAMPTZ,
  last_generated_at     TIMESTAMPTZ,
  next_due_at           TIMESTAMPTZ,                    -- LIVE only: scheduled time of next regeneration
  force_requested_at    TIMESTAMPTZ,
  force_requested_by    UUID,
  attempts              INT  NOT NULL DEFAULT 0,
  last_error            TEXT,
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (customer_id, period, bucket_date, tz, lang, model_name, model),
  FOREIGN KEY (customer_id, period, bucket_date, tz)
    REFERENCES periodic_report_state(customer_id, period, bucket_date, tz)
);
```

Notes:

- `tz` is in both state and job PKs (matches result PK). A timezone change does not mutate existing rows; old-tz state rows move to `status='archived'` and new-tz rows are created lazily (see §"Customer-level timezone").
- `next_due_at` lives on the job table because it is per-variant: each variant ticks independently for LIVE.
- The state status enum excludes work-in-flight values (`processing`/`done`/`failed`). Those are job-level concerns. State only answers "is the data ready to be analyzed at all?"
- `story_analysis_state.status` includes `archived` so the lifecycle covers the case where every `story_version` of a `story_id` has been deleted from the customer DB (e.g., by `refresh-window` or `backfill`). Unarchive-in-place is allowed: if the same `story_id` re-appears via a later window-replace, the state row UPDATEs back to `pending` with cleared timestamps and any stale `*_analysis_job` rows from the archived run are deleted. See issue #294 decision 1.
- A worker tick walks: enqueue new jobs for `ready` state rows that lack a job for a "should-exist" variant; re-enqueue jobs for `dirty` state rows by incrementing job `generation` and resetting status to `queued`; pick up `queued` jobs in FOR UPDATE SKIP LOCKED batches.

---

## Readiness and scheduling

### Story readiness (state-level)

A `story_analysis_state` row transitions `pending → ready` when **either**:

- `NOW() - last_member_at >= ANALYSIS_STORY_IDLE_MINUTES` (default: 15min), **or**
- `NOW() - first_member_at >= ANALYSIS_STORY_MAX_WAIT_HOURS` (default: 6h) — forces progress when members keep trickling in.

On entering `ready`, the worker ensures a `queued` `story_analysis_job` row exists for every "should-exist" variant (typically just the customer's default lang/model; additional variants are added by force-regenerate).

### Periodic report readiness (state-level)

| period | state `ready` condition |
|---|---|
| LIVE | always immediately ready upon creation; subsequent re-readying is driven by the job-level `next_due_at` (per variant), not the state row |
| DAILY | `bucket_date` end (in customer tz) + settle window; AND no ingest activity for `ANALYSIS_IDLE_QUIET_MINUTES` (default 30min). The settle window is `ANALYSIS_SETTLE_HOURS_DAILY_WITH_WATERMARK` (default 1h) when a `strict` `cursor_watermark` is at or past the bucket end; otherwise `ANALYSIS_SETTLE_HOURS_DAILY` (default 3h). Soft watermarks and missing watermarks both fall back to the baseline. |
| WEEKLY | same with 6h settle (watermark not consumed in Phase 0.5 — deferred to #298) |
| MONTHLY | same with 12h settle (watermark not consumed in Phase 0.5 — deferred to #298) |

For LIVE, each variant has its own `next_due_at = last_generated_at + ANALYSIS_LIVE_REFRESH_MINUTES` (default 60min). The worker re-queues the variant job (status back to `queued`, `generation++`) when `NOW() >= next_due_at`, regardless of state row status. Previous LIVE result row gets `superseded_at` on the next successful generation.

### Dirty transitions

A `state` row that has already progressed past pending — i.e., is `ready` and has at least one variant job in `processing` or `done` — is moved to `dirty` when source data underneath it changes after analysis began or completed. Triggers differ by state type:

For **`periodic_report_state`**:

1. A `refresh_window` or `backfill` envelope is ingested whose `[from, to)` overlaps the bucket's date range, **or**
2. A regular Phase 2 batch is ingested with an `event_time` that falls inside a `done` bucket's range.

For **`story_analysis_state`**:

1. A new `story_member` row is ingested for a `story_id` whose state is already past `ready` (i.e., at least one variant job is `done` or `processing`). `last_member_at` is updated as usual, and the state row transitions to `dirty`.
2. A `refresh_window` or `backfill` envelope is ingested that mutates an existing member or adds a member for this story (covered by the same hook as rule 1 once it lands in `story_member`).

In both cases, transitioning the state row to `dirty` is the *trigger*; the worker then re-queues variant jobs (see below). The state row does not skip back to `pending` — `dirty` already implies "was ready, now needs rerun."

Notes:

- A customer `timezone` change does **not** dirty existing rows. It supersedes/archives them and creates new-tz rows lazily; see §"Customer-level timezone".
- Force regenerate does **not** dirty the state row. It re-queues variant jobs directly (see §"Force regenerate"). Force is a variant-scoped operation; the underlying source data has not changed.

When a state row is marked `dirty`, the worker re-queues all variant jobs that exist underneath it (status → `queued`, `generation++`) because the underlying data the prior generation was built from is now known to be incomplete.

Dirty state rows are picked up by the next worker tick.

### Guardrails

- `ANALYSIS_MAX_GENERATION` (default 10) caps how many times a single variant job (a row in `story_analysis_job` or `periodic_report_job`) can be regenerated automatically — that is, by dirty-driven re-queues. Beyond the cap, the worker stops auto-requeueing the job and emits an alarm. User-initiated force regenerate is still allowed past the cap.
- `ANALYSIS_PER_CUSTOMER_CONCURRENCY` (default 3) limits parallel LLM calls per customer.
- All thresholds are environment variables.

### Worker structure

aimer-web already has a Postgres-backed job pattern (`redaction_jobs` / `redaction_job_worker.ts`). The new worker reuses it:

- New file `src/lib/instrumentation/analysis-job-worker.ts` modeled on `redaction-job-worker.ts`.
- Registered in `src/instrumentation.ts` alongside the existing workers.
- Uses `SELECT ... FOR UPDATE SKIP LOCKED` and per-(customer, kind) advisory locks for multi-instance safety.
- Boot-time recovery scan to mark stuck `processing` job rows back to `queued`.

---

## Force regenerate

API (aimer-web):

```
POST /api/customers/{customer_id}/analysis/story/{story_id}/regenerate
        ?lang=...&model_name=...&model=...             (all optional;
                                                        ?tz=... is rejected
                                                        with 400 invalid_param)
POST /api/customers/{customer_id}/analysis/report/{period}/{bucket_date}/regenerate
        ?tz=...&lang=...&model_name=...&model=...      (all optional)
```

Story analysis output is timezone-independent (see §aimer changes), so
the story endpoint does **not** accept `?tz=…` — a request that
includes it is rejected with `400 invalid_param`. Only the report
endpoint accepts `?tz=…`. The `lang` / `model_name` / `model` query
params behave identically on both endpoints.

`customer_id` is part of the path because aimer-web has no server-side
"active customer" session selector — `selectedCustomerId` lives in
client-only React context (`src/hooks/use-customer-context.tsx`) and is
not propagated server-side. The customer-id-in-path convention matches
the existing `/api/admin/customers/[customerId]/...` admin layer and is
extended here to the non-admin analyst layer. `story_id`, `period`, and
`bucket_date` are scoped *under* that customer's database. (This URL
shape supersedes an earlier sketch that omitted `customer_id` from the
path; see issue #294 decision 5.) `bucket_date` must be a real ISO
calendar date (`YYYY-MM-DD`) on the report endpoint; impossible values
like `2026-02-31` are rejected with `400 invalid_report_path`. For
`period=LIVE` the only accepted `bucket_date` is the synthetic epoch
`1970-01-01` (issue #294 decision 4: LIVE rows are pinned to that
date in `periodic_report_state` and `periodic_report_result`); any
other value is rejected with `400 invalid_report_path` so the API
contract matches the variant keys the worker and reconcile will
actually produce.

Default contract (path-only call):

- Report endpoint: `tz` defaults to the customer's **current** `customers.timezone`. Story endpoint: there is no `tz` axis to default — the result variant PK has no `tz` column on the story side.
- `lang` defaults to the env-configured fallback `ANALYSIS_DEFAULT_LANG`.
- `model_name` / `model` default to the customer's **resolved default model**, computed asynchronously by `resolveDefaultModel(customer_id)` (`src/lib/analysis/default-model.ts`) in a three-tier order (amendment, #473): (1) the per-customer override row in `customer_default_model`, else (2) the admin-set global default in `system_settings` under key `analysis_default_model` (value `{ modelName, model }`), else (3) the env fallbacks `ANALYSIS_DEFAULT_MODEL_NAME` / `ANALYSIS_DEFAULT_MODEL`. A stored value that is no longer in `ANALYSIS_MODEL_CATALOG` is skipped (logged) and resolution falls through to the next tier, so a stale default never 500s. The same async resolver — not the sync `getDefaultModelPair()`, which is re-scoped to env/catalog allow-list duties only — backs every default-omitting entry point: worker seeding, and the regenerate / summary / detail loaders. The per-customer and global defaults are set by authorized users in-app (System Administrator for the global default; System Administrator or an assigned Analyst for a per-customer override); see #473.
- The result variant identified by the full variant PK is the one regenerated. The variant PK is `customer_id, period, bucket_date, tz, lang, model_name, model` for periodic reports and `customer_id, story_id, lang, model_name, model` (no `tz`) for stories.

Variant selection (query params):

- Report endpoint: any subset of `tz`, `lang`, `model_name`, `model` may be passed to target a non-default variant.
- Story endpoint: any subset of `lang`, `model_name`, `model` may be passed (e.g., regenerate the English copy without touching the Korean one). `tz` is rejected as above.
- If a query value names a variant that has never been generated, a fresh `*_analysis_job` row is inserted for that variant with `generation = 1, status = 'queued'`. The corresponding `*_analysis_state` row is not modified.

Behavior:

- Resolves the target variant row in `story_analysis_job` or `periodic_report_job`. If a row exists, sets `force_requested_at = NOW()`, `force_requested_by = current user`, `status = 'queued'`, `generation++`. If no row exists for the requested variant (first-time generation in that language/model), inserts a fresh `generation=1` row in `queued`.
- Does **not** touch the corresponding `state` row's status. Force is a variant-level operation; sibling variants are untouched.
- Returns `202 Accepted` with `{state_pk, variant: {…}, generation}`. The `variant` object includes `tz` on the report endpoint and omits it on the story endpoint.
- Worker on next tick picks up the `queued` job; result row written with the new `generation`; prior result row for the same `(state_pk, variant)` gets `superseded_at = NOW()`.
- The aimer call carries no `force` flag — the new aimer mutations are stateless and have no cache to bypass. Force regenerate is entirely an aimer-web-side concern: aimer-web bypasses its own result cache by writing a fresh `generation` row.

UI (aimer-web):

- A "Regenerate" button on the result view; confirmation modal explains cost implication.
- After click, the view polls the bucket status and shows a banner "Regenerating (started 2m ago)…".

aice-web-next: **no force UI**. Regeneration is a producer-side operation and stays in aimer-web per the decision rule.

---

## Priority tiering

Computed by aimer-web at write time and stored on the result row. Inputs are two orthogonal axes returned by (or derived from) the LLM:

- **severity_score** (0.0–1.0): "if this turned out to be a real attack, how bad is it" — impact, blast radius, asset criticality.
- **likelihood_score** (0.0–1.0): "how likely is this actually malicious rather than noise / false positive" — evidence quality, IoC matches, plausible benign explanations.

The two axes are kept separate everywhere they appear on disk (`*_analysis_result.severity_score`/`likelihood_score`, `periodic_report_result.aggregate_severity_score`/`aggregate_likelihood_score`). `priority_tier` is always a deterministic, code-computed value — never a stored LLM judgement. For leaf rows it is a matrix lookup on the pair; for periodic reports it is derived from included leaf tiers + baseline drift (see §"For periodic reports" below). The aggregate scores on `periodic_report_result` are informational max-per-axis values, not the priority input.

### Matrix (per-event and per-story results)

|              | L < 0.4 | 0.4 ≤ L < 0.6 | 0.6 ≤ L < 0.8 | L ≥ 0.8  |
|--------------|---------|---------------|---------------|----------|
| S ≥ 0.8      | MEDIUM  | HIGH          | CRITICAL      | CRITICAL |
| 0.6 ≤ S < 0.8 | LOW     | MEDIUM        | HIGH          | HIGH     |
| 0.4 ≤ S < 0.6 | LOW     | LOW           | MEDIUM        | MEDIUM   |
| S < 0.4      | LOW     | LOW           | LOW           | LOW      |

Both per-axis thresholds (`0.4 / 0.6 / 0.8`) and the cell-to-tier mapping are env-configurable (`ANALYSIS_PRIORITY_SEVERITY_THRESHOLDS`, `ANALYSIS_PRIORITY_LIKELIHOOD_THRESHOLDS`, `ANALYSIS_PRIORITY_MATRIX`). Admin UI for runtime tuning is a Phase 4 item.

The previous single-threshold upgrade clauses (`member_count ≥ N`, `known_ioc_hit`) are folded into the **likelihood** axis rather than priority, since each is evidence that the threat is real, not evidence that it is severe:

- `known_ioc_hit` forces a floor: effective likelihood = `max(stored_likelihood, 0.95)`. The signal is sourced from `story.known_ioc_hit` (`BOOLEAN NOT NULL DEFAULT FALSE`), populated at ingest time from the optional `known_ioc_hit` field on the `phase2.story.v1` payload (omitted ⇒ `false`).
- A high correlated-member count (≥ N, env-configurable) adds a smaller floor (`max(stored_likelihood, 0.7)`).

These floors are applied by aimer-web **only at matrix-lookup time** when computing `priority_tier`. The stored `likelihood_score` column always holds the LLM's unmodified estimate; the floor adjustment is not persisted. This preserves calibration data (`👍`/`👎` feedback vs raw model output) and makes the floor policy auditable and revisable without rewriting historical rows. Reading the stored row gives the model's raw estimate; only `priority_tier` reflects the floored value.

### For periodic reports

A periodic report has no LLM-returned scores (the report prompt summarizes; it does not score). aimer-web derives two **informational** aggregate scores at write time — these answer "how high did severity and likelihood get across the period, axis by axis" for display and analytics — but the report's `priority_tier` is computed by a separate rule (see below):

#### Leaf selection: coverage vs calibration (round 14)

A report variant is keyed by `(lang, model_name, model)`, but its **coverage** (which story/event analyses it includes) and its **calibration** (how the aggregate scores and tier are computed) are governed by two separate rules. The split exists because a default-model change leaves existing leaves on the old model: a strict same-`(model_name, model)` selection would silently drop them and render empty reports until every leaf is re-analyzed under the new model (see round 14 / #379).

- **Coverage — never drop.** Each candidate story/event leaf is selected by a deterministic preference order = `[report model, then the model-catalog fallback order]`: prefer the report's own `(model_name, model)`; if absent, fall back to the first available model in the fixed `model-catalog` order. `lang` stays strict (a real variant axis, not a fallback axis) and `superseded_at IS NULL` stays. A fixed catalog order — not a data-dependent "most-used" — keeps selection deterministic across regenerations, which keeps the `R{j}` token numbering (§"Report-scope rewrite") stable.
- **Calibration — hybrid.** Only the *calibrated scores* — `aggregate_severity_score`, `aggregate_likelihood_score` (both `MAX`), and `report_priority_tier` (maxTier) — are computed from the **report-model subset** of the selected leaves (plus baseline drift); never from fallback-model leaves, whose scores may be calibrated on a different scale. Everything that is **not** a calibrated score ranges over the **full** selected set: the narrative and leaf-derived sections (`story_highlights`, `notable_events`) *and* `aggregate_ttp_tags` — TTP tags are coverage/narrative facets, not scores subject to cross-model calibration. A coverage indicator (report-model leaf count vs total selected) is surfaced so the transient post-migration understatement is honest, not hidden; it is **derived read-time from `input_*_refs`, not a stored column** (`periodic_report_result` rows are immutable audit records — no coverage column is added). Counts only, not the score-combination method (per the #386 guardrails).
- **Scope.** The fallback applies only to the **default / system-seeded** report path (report model == the configured default). An explicitly analyst-requested **alternate-model** report (the A/B comparison path, #458) stays **strict** (no fallback) — honest-empty + regenerate CTA, consistent with #458.

The aggregate scores below therefore range over the **report-model subset** of the included leaves:

```
aggregate_severity_score = max(
    max(report-model story_analysis_result.severity_score),
    max(report-model event_analysis_result.severity_score),
    baseline_drift_severity(period)     -- 0.0–1.0
)

aggregate_likelihood_score = max(
    max(report-model story_analysis_result.likelihood_score),
    max(report-model event_analysis_result.likelihood_score),
    baseline_drift_likelihood(period)   -- 0.0–1.0
)
```

Taking max **independently** per axis means the entity contributing the aggregate severity can differ from the entity contributing the aggregate likelihood. That is acceptable for an informational maximum.

`baseline_drift_severity` and `baseline_drift_likelihood` map the statistical signal onto both axes:

- **severity**: normalized magnitude of the largest category delta vs the prior period (e.g., min-max scaled z-score, clamped to `[0, 1]`).
- **likelihood**: `1.0` if any delta exceeds the configured noise threshold, else `0.0`. Statistical drift, when it exceeds noise, is treated as a high-confidence signal — the data does not lie about its own distribution.

Exact formulas are fixed in code and documented alongside `analysis-job-worker.ts`; noise thresholds are env-configurable.

The report's `priority_tier` is computed **from the report-model leaf subset's tiers** (the same subset the aggregate scores range over), not from the aggregate scores and not from fallback-model leaves:

```
report_priority_tier = max over {
    each report-model story_analysis_result.priority_tier,
    each report-model event_analysis_result.priority_tier,
    matrix(baseline_drift_severity, baseline_drift_likelihood)
}
```

This guarantees **leaf monotonicity**: a report can never be tagged at a lower tier than the worst-priority report-model leaf it cites, and baseline drift contributes via its own (severity, likelihood) → matrix evaluation. Under round 14's coverage/calibration split, monotonicity holds over the report-model subset; fallback-model leaves are narrated but, by design, do not raise the tier (their scores may be on a different scale), and the coverage indicator discloses how much of the selected set was scored. Deriving `priority_tier` from the aggregate scores would silently downgrade reports that include a leaf whose effective likelihood was raised by `known_ioc_hit` or a high `member_count` — those floors are leaf-tier-lookup-only per the previous section, so the raw `likelihood_score` on the leaf row does not reflect them, and `aggregate_likelihood_score = max(raw leaf likelihoods, ...)` would miss the adjustment. Using leaf tiers directly sidesteps the issue without persisting floor inputs.

### LLM contract

The pipeline has **four explicit layers** for scores; the same field name appears in different units at each layer and the RFC text below names each layer to avoid double-normalization or missing-normalization bugs:

| Layer | Names | Units / shape |
|---|---|---|
| 1. LLM JSON output (prompt's structured-output schema) | `severity_score`, `likelihood_score` | integer `0..100`, inclusive |
| 2. aimer normalization | (in `normalize_score`) | integer/100 → `Float` clamped to `[0.0, 1.0]` |
| 3. GraphQL wire (auth-mtls SDL) | `severityScore`, `likelihoodScore` | `Float!`, `[0.0, 1.0]` |
| 4. aimer-web storage (customer DB) | `severity_score`, `likelihood_score` | `DOUBLE PRECISION NOT NULL`, `[0.0, 1.0]` |

`STORY_PROMPT` and the event-analysis prompt (RFC 0001) ask the model to return five structured fields alongside the markdown `analysis`:

- `severity_score`, `likelihood_score` — at the LLM JSON layer (integer `0..100`).
- `severity_factors` (array of short noun phrases, see §"Score factor articulation").
- `likelihood_factors` (same shape).
- `ttp_tags` (array of MITRE ATT&CK technique IDs, see §"MITRE ATT&CK TTP tagging").

aimer normalizes scores once between layers 1 and 2 via the existing `normalize_score` helper, called twice per response (once per axis). aimer-web never re-normalizes. The GraphQL wire and storage shapes share the same numeric range and only differ in naming convention (camelCase wire vs snake_case columns).

`PERIODIC_SECURITY_REPORT_PROMPT` does **not** ask for scores or factors — aggregation is computed by aimer-web from already-stored leaf rows (already in storage units, `[0.0, 1.0]`). The prompt is, however, given the union of included-leaf `ttp_tags` as part of its input bundle and is instructed to reference techniques by ID when relevant in the narrative ("the highest-likelihood narrative this period mapped to T1078 and T1110.001").

### Why two axes, not one

A single composite collapses two cases operators triage differently:

- `(severity=1.0, likelihood=0.5)`: "if this is real it's catastrophic, but it's only ~50% real" → monitor closely, prepare response.
- `(severity=0.5, likelihood=1.0)`: "confirmed real, but limited impact" → routine handling.

Both collapse to the same `0.5` under a composite. The matrix preserves the difference. Splitting also makes the priority decision auditable in code (matrix lookup) rather than opaque inside the LLM's score, and gives a clean prompt definition for each axis. The split additionally subsumes the role a separate "LLM self-confidence" field would have played: `likelihood_score` is the domain-meaningful version of the same signal with better calibration semantics.

UI policy:

- aimer-web default list view shows CRITICAL + HIGH; explicit "show all" toggle for MEDIUM/LOW.
- aice-web-next deep-link badges appear only for CRITICAL + HIGH.
- Periodic report body cites top-K (3–5) story highlights; the rest collapse into a "Other analyzed stories" list.

---

## MITRE ATT&CK TTP tagging

Each leaf analysis result (`event_analysis_result`, `story_analysis_result`) carries a `ttp_tags` array of MITRE ATT&CK technique IDs that the LLM judged applicable to the analyzed entity. Periodic reports carry `aggregate_ttp_tags` as the union of included leaves, deduplicated and sorted.

### Why store TTP IDs

Free-form `analysis_text` narrative is good for human reading but does not support slicing — operators cannot say "show me all CRITICAL analyses involving T1078 (Valid Accounts) this month". A structured ID list enables filtering, longitudinal trend tracking, and threat-hunting workflows that the markdown surface alone cannot.

### LLM contract

`STORY_PROMPT` and the event-analysis prompt instruct the model to emit `ttp_tags` in its structured output:

```json
"ttp_tags": {
  "type": "array",
  "items": {
    "type": "string",
    "pattern": "^T[0-9]{4}(\\.[0-9]{3})?$"
  },
  "description": "MITRE ATT&CK technique IDs matched by this analysis. Empty array if no clear mapping. Do not invent or guess IDs."
}
```

The model relies on its training knowledge of ATT&CK; no RAG / retrieval is performed. The pattern enforces shape at decode time but cannot prevent the model from emitting a syntactically valid yet non-existent ID (e.g., `T9999.123`).

### Validation against vendored MITRE data

aimer-web vendors MITRE ATT&CK as derived data, refreshed manually like the aimer SDL (#281 pattern):

- `schemas/mitre-attack-techniques.json` — derived list of `{id, name}` extracted from the upstream STIX 2.1 bundle (`github.com/mitre-attack/attack-stix-data`).
- `schemas/mitre-attack.version` — pinned version (e.g., `v16.1`).

MITRE does not provide a live classification API; only static versioned STIX bundles via GitHub and a TAXII server, both serving the same data. The vendored snapshot is sufficient for validation; refresh PRs follow MITRE's ~6-month release cadence or earlier on demand.

Before storage, aimer-web's write path filters each LLM-returned `ttp_tags` value:

- Tags present in the vendored list → kept.
- Tags absent (hallucinated or post-vendored-version techniques) → dropped, count incremented in an `analysis_ttp_hallucination_total` metric for monitoring.

When at least one tag is dropped, aimer-web emits an `ai_analysis.ttp_tag_dropped` audit row (see RFC 0001 §"Audit logging — new actions") carrying the target `(customer_id, aice_id, event_key)` (or `story_id` for story-level), the dropped IDs, and a `reason` of `'not_in_vendored_mitre'` (absent from the snapshot) or `'invalid_format'` (failed the regex at the JSON-schema layer for some reason). The dropped IDs are stored on the audit row, never on the result row.

### Aggregation

`periodic_report_result.aggregate_ttp_tags` is computed at periodic-report write time as the set-union of `ttp_tags` over every included `story_analysis_result` and `event_analysis_result`, sorted ascending. Baseline drift contributes no TTP tags (statistical signal, no technique mapping).

### UI

The aimer-web result page renders TTP tags as chips next to the priority badge; hover reveals the technique name from the vendored list. The aimer-web overview list page (`/analysis`) adds a TTP filter for slicing across all analyses.

aice-web-next deep-link badges do **not** expose TTP tags — same content-free principle as the score axes.

---

## Score factor articulation

Each leaf analysis stores two arrays of short noun phrases — `severity_factors` and `likelihood_factors` — articulating what drove each score. Periodic reports do **not** have their own factors (they don't score themselves); the report prompt may reference leaf factors verbatim in its narrative.

### Why store articulated factors

`severity_score = 0.85` tells the operator *what* but not *why*. Without articulation, scores are opaque LLM judgement that operators cannot interrogate or learn to trust. Storing the LLM's own short reasoning per axis serves three purposes:

- **Operator trust** — the chip list is auditable on first glance.
- **Calibration data** — Phase 4 per-factor 👍/👎 feedback identifies which articulation patterns correlate with operator agreement.
- **Drift detection** — if the LLM consistently produces vague factors ("suspicious activity") rather than concrete ones ("lsass.exe memory read from non-standard process"), prompt or model quality is degrading.

Unlike `ttp_tags`, factors are **free text** — there is no external taxonomy to validate against. Quality is governed by prompt engineering and Phase 4 feedback, not by an enum.

### LLM contract

Both axes follow the same schema shape:

```json
"severity_factors": {
  "type": "array",
  "items": { "type": "string", "maxLength": 80 },
  "minItems": 1,
  "maxItems": 5,
  "description": "Short noun phrases (not sentences) explaining what drives the severity score, ordered most impactful first. Each must reference something concrete observed in the input — not generic risk language."
}
```

`minItems: 1` blocks empty arrays — if the LLM scored, it must articulate. `maxLength: 80` blocks paragraph-length factors. `maxItems: 5` caps the chip list to a glance-readable count.

The prompt provides explicit good/bad examples to constrain content quality:

- **Good**: `"domain controller targeted"`, `"credential dumping via lsass access"`, `"matches known T1110.001 pattern"`, `"two independent IoC hits"`.
- **Bad**: `"the attacker did bad things"` (sentence, not phrase), `"suspicious activity"` (generic, not concrete), `"high risk"` (restates the score, no information).

### `"insufficient evidence"` sentinel

When the input is genuinely too thin to articulate even one concrete factor (e.g., redaction stripped most of the payload, or only one heavily-redacted member), the model returns:

```json
"severity_factors":   ["insufficient evidence"],
"likelihood_factors": ["insufficient evidence"]
```

This is the **only** approved padding output and is explicitly distinguished from the "I tried but came up with generic words" failure mode. aimer-web tracks the rate of `"insufficient evidence"` per period as `analysis_factors_insufficient_total`. A spike indicates either input quality degradation (redaction too aggressive) or prompt instability.

### Validation

Shape-only at the aimer-web write path, applied per axis independently:

1. Drop items that are empty or > 80 characters.
2. Drop items starting with `"The "` or `"This "` (sentence detectors) — keeps the chip column purely noun-phrase.
3. Cap the array at 5 after filtering (keep first 5; LLM ordered most impactful first).
4. **Post-filter empty-array recovery**: if step 1–3 leave the array empty even though the LLM returned `minItems: 1`-respecting output, replace with `["insufficient evidence"]` and emit an `ai_analysis.factor_dropped` audit row (see RFC 0001 §"Audit logging — new actions") carrying `axis`, the original dropped items, and `reason: 'all_items_filtered'`. This honors the wire contract (`severityFactors` / `likelihoodFactors` always carry ≥ 1 item) while keeping the analysis surface visible to operators and preserving the dropped raw text for prompt-drift debugging.

No content validation beyond shape — the LLM owns articulation quality, monitored via the metrics above, the `ai_analysis.factor_dropped` audit rate, and Phase 4 feedback.

### UI

Result page shows factor chips inline under each score, expandable to full text on hover:

```
Severity 0.85  [HIGH]
  ▸ domain controller targeted
  ▸ credential dumping via lsass access
  ▸ lateral movement to file server

Likelihood 0.72
  ▸ matches known T1003.001 pattern
  ▸ two independent IoC hits
  ▸ no plausible benign explanation found
```

aice-web-next deep-link badges do **not** expose factors — same content-free principle as scores and TTP tags.

### Periodic report narrative

`PERIODIC_SECURITY_REPORT_PROMPT` receives included-leaf `severity_factors` and `likelihood_factors` as part of its input bundle and is instructed to weave the strongest factors into the `notable_events` and `story_highlights` sections of the report — quoting verbatim is acceptable when the phrase is precise enough. The report itself does not produce its own factors arrays.

---

## Dedup across Phase 1 and Phase 2

The same upstream event can appear in both `detection_events` (Phase 1) and `story_member` (Phase 2, via a story). Investigation confirmed that `event_key` carries identical values across all three paths (aice-web-next `locator.id` → `baseline_triaged_event.event_key` → `event_group_member.event_key`).

**Dedup key**: `(aice_id, event_key)`.

- For `detection_events`: direct.
- For `story_member`: lift via parent `story.source_aice_id` (a JOIN; provided as a view `v_event_identity`).
- For `baseline_event`: `(source_aice_id, event_key)` directly.

Application in the periodic report input builder:

1. Select top stories first (narrative wins on information density).
2. Collect their `(aice_id, event_key)` set.
3. Select top single-event analyses *excluding* anything in the set.
4. Baseline aggregates are unaffected (they appear as statistics, not citations).

UI cross-reference: when a `detection_event` is also a `story_member`, the event detail page in aice-web-next shows a "Part of Story #N" badge linking to the story analysis in aimer-web.

---

## aimer changes (server-side)

The following changes land in the aimer Rust repo. They are sequenced **before** aimer-web Phase 1.

All items below are **new code on auth-mtls** and are **stateless** (aimer stores nothing for any of them). The pre-existing auth-jwt surface — including `generateReport` and `ReportKey` — is **not modified** by this RFC; it will be deleted wholesale in a future effort outside this RFC. auth-jwt code may be reused as in-process helpers (LLM client, prompt loader, redaction utilities).

| Item | Change |
|---|---|
| `analyzeStory(customer_id, story_id, members: [StoryMemberInput!]!, story_metadata, lang, model, name)` | New mutation on **auth-mtls only**. `members` carry the redacted event content from `story_member.event` only, with tokens already namespaced per §"Token namespacing for multi-event LLM inputs". `story_metadata` is non-PII story facts (id, time range as UTC ISO 8601, member count, role distribution) — explicitly **does not** include `story.summary_payload`. **No `timezone` parameter** (story output is UTC). **No `force` parameter** (no aimer-side cache to bypass). Stateless: no keyspace, no cache key. |
| `generatePeriodicSecurityReport(customer_id, period, date, timezone, lang, model, name, inputs)` | New mutation on **auth-mtls only**. `inputs` is a structured object: `{story_analyses: [...], event_analyses: [...], baseline_aggregates: {...}}`. `timezone` is retained and used **only** to render time strings inside the prompt (e.g., "events between 14:00–16:30 KST"); it is not a cache key dimension because there is no cache. **No `force` parameter**. Stateless. |
| `STORY_PROMPT` | New prompt — narrative framing (kill chain, lateral movement, attacker hypothesis). The LLM-level JSON schema emits scores as integer `0..100` and aimer normalizes per the four-layer pipeline documented in §"LLM contract" before exposing the result on the wire. The wire-level return type is `StoryAnalysisResult` with markdown `analysis`, scores `severityScore` / `likelihoodScore` (`Float!`, `[0.0, 1.0]`), articulation `severityFactors` / `likelihoodFactors` (`[String!]!`, see §"Score factor articulation"), and taxonomy `ttpTags` (`[String!]!`, see §"MITRE ATT&CK TTP tagging"). Includes an explicit instruction to preserve `<<REDACTED_*_E{i}_*>>` tokens verbatim. |
| `PERIODIC_SECURITY_REPORT_PROMPT` | New prompt — synthesis across stories, single events, and baseline statistics; period-aware framing. Receives included-leaf `ttp_tags` / `severity_factors` / `likelihood_factors` in its input bundle and is instructed to weave them into the narrative. Does **not** return its own scores or factors; aimer-web aggregates `severity_score` / `likelihood_score` / `ttp_tags` from leaf rows. Includes an explicit instruction to preserve `<<REDACTED_*_R{j}_*>>` tokens verbatim. |

**Contract guarantee for tracking fields**: both new mutations always return `prompt_version` (string identifying the prompt revision used) and `model_actual_version` (the provider-reported model snapshot/version actually invoked) in their response payloads. aimer-web depends on these being present and uses them as `NOT NULL` columns. If a future model provider cannot supply `model_actual_version`, aimer must substitute a deterministic placeholder (e.g., the requested `model` string) rather than omitting the field.

**Contract guarantee for scoring fields**: `analyzeStory` (and the RFC 0001 event-analysis mutation) always return both `severityScore` and `likelihoodScore` as separate `Float!` fields on the GraphQL wire (camelCase to match existing aimer SDL convention; aimer-web maps them to the snake_case storage columns), each clamped server-side to `[0.0, 1.0]`. There is no single `threatScore` field on the wire.

**Contract guarantee for articulation and tagging fields**: same two mutations also return `severityFactors: [String!]!`, `likelihoodFactors: [String!]!`, and `ttpTags: [String!]!` as non-null arrays (possibly empty for `ttpTags`; `severityFactors` / `likelihoodFactors` carry at least one item, with `"insufficient evidence"` reserved as the explicit thin-input sentinel). Element-level validation (length, pattern, MITRE membership) happens server-side in aimer-web before storage; aimer itself only enforces shape via the LLM structured-output JSON schema.

**Surface**: mTLS-only. The aimer-web background worker calls these mutations over mTLS for both automatic generation and operator-initiated force regenerate; the latter does not require a different surface because aimer is stateless either way.

---

## aice-web-next changes

Minimal — sender-side stays mostly intact. Two additions:

### 1. Optional `cursor_event_time` watermark (small PR, recommended but not required)

- `EventsEnvelopeInput` gains two optional fields: `cursor_event_time?: string` (ISO 8601 UTC) and `cursor_quality?: 'strict' | 'soft'`. Both must appear together or both absent; aimer-web rejects half-present claims as malformed (#295 decision 1).
- Baseline batches send `strict` with `aimer_push_state.last_pushed_event_time`.
- Story batches send `soft` (late-commit stragglers exist).
- Backward compatible: schema_version bump not required.
- aimer-web stores both fields on every `periodic_report_state` row for the customer (forward-only via `GREATEST`; strict wins ties), and the worker uses `ANALYSIS_SETTLE_HOURS_DAILY_WITH_WATERMARK` (default 1h) instead of `ANALYSIS_SETTLE_HOURS_DAILY` (default 3h) when a `strict` watermark is at or past a DAILY bucket's end.
- The recovery path on hot-path-hook failure is the `phase2.ingest` audit row: aimer-web extends its `details` JSONB with `cursorEventTime` / `cursorQuality` on every successful cursor-bearing ingest. The cursor-bearing handler awaits an `auditLogOrThrow` variant so audit-write failures surface; on failure the handler logs at error level and still returns 200 (the JTI is already consumed). The reconcile pass scans recent `phase2.ingest` audit rows and forward-patches the watermark accordingly (#295 decision 9).

### 2. Deep links to aimer-web

Add five entry points (see §"What aice-web-next surfaces" table). Each is a single-row badge or card component that:

- Reads from a small aimer-web endpoint (`GET /api/analysis/{...}/summary`) returning only `{exists, priority_tier, severity_score, likelihood_score, score_kind, link}`. `score_kind` is `"leaf"` for event/story summaries (scores came from an LLM call) and `"aggregate"` for periodic-report summaries (scores were derived by aimer-web from included leaf rows + baseline drift). This shape is uniform across all surface types so aice-web-next has one client.
- Does **not** fetch or render the analysis content itself.
- Opens the aimer-web URL in a new tab (or in-app modal if same-origin permits).

The summary endpoint is intentionally minimal so aice-web-next never needs the analysis-text rendering stack.

---

## Phased delivery

Each phase ends with a verification gate before the next begins.

### Phase 0 — Foundations (no LLM)

Goal: state machinery, schemas, timezone column, worker skeleton.

- **aimer**: no work. (The originally-planned PR-1 — adding timezone to `ReportKey` and `generateReport` — was cancelled in round 8 because the new mutations are auth-mtls only and stateless from day 1, and the existing auth-jwt surface is not modified by this RFC.)
- **aimer-web**: PR 2 — migrations (`customers.timezone`, `story_analysis_state`, `story_analysis_job`, `periodic_report_state`, `periodic_report_job`, `story_analysis_result`, `periodic_report_result`); `analysis-job-worker.ts` skeleton with state worker + job dispatcher (logs state transitions and would-be-queued jobs, no LLM call); ingest hooks for dirty marking on state rows; force-regenerate API endpoint stub returning 202; admin SQL-only timezone change (no UI yet); unit tests for state ready/dirty transitions and job enqueue logic.
- **aice-web-next**: nothing (PR optional in parallel — see Phase 0.5).

Verification gate: state machine transitions exercised per §"Readiness and scheduling". The gate is passed via **either** path:

- **(a) Real-environment 48h observation**: dev ingest runs for 48 hours; logs show no spurious `dirty`, no stuck `pending`, and the reconciliation second-pass reports zero missing-row seeds and zero forward-patches.
- **(b) Deterministic acceptance suite** (preferred in pre-release dev where (a)'s wall-clock is the dominant constraint): a fixture-driven test exercises every transition documented in §"Readiness and scheduling", enumerated below. CI-green on the suite plus manual review of one fixture run is the equivalent passing criterion. The worker reads `NOW()` through a mockable seam (e.g., `getCurrentTimestamp()` helper) so timers (story idle 15min, story max-wait 6h, DAILY settle 3h / WEEKLY 6h / MONTHLY 12h, idle-quiet 30min, LIVE 60min cadence) can be fast-forwarded deterministically without wall-clock.

The transition scenarios the suite must cover (each verified by SQL inspection of state row history + emitted job rows):

1. **Story idle → ready** — member ingest, fast-forward 16min, state = `ready`.
2. **Story max-wait → ready** — trickle members within idle threshold, fast-forward 6h+1min, ready (max-wait wins over last-member).
3. **Story dirty cascade** — `ready` state + at least one job in `processing|done` (dry-run OK) + new member ingest → state `dirty`, job re-queued with `generation++`.
4. **Periodic refresh-window overlap → dirty** — refresh-window envelope overlapping a `ready` `periodic_report_state` row → dirty.
5. **Periodic regular-batch dirtying a done bucket** — regular (non-refresh-window, non-backfill) Phase 2 batch ingested with `event_time` inside a `done` bucket's date range → state `dirty`. Distinct from scenario 4: this covers the late-event ingest path documented in §"Dirty transitions" beyond refresh-window/backfill.
6. **DAILY settle → ready** — fast-forward bucket end + `ANALYSIS_SETTLE_HOURS_DAILY` + 30min idle-quiet → ready (additional sub-case: 1h settle when a strict `cursor_watermark` covers the bucket).
7. **WEEKLY settle → ready** — same shape as scenario 6, but with the 6h settle window §"Readiness and scheduling" specifies for WEEKLY (no separate env var).
8. **MONTHLY settle → ready** — same shape with the 12h settle window §"Readiness and scheduling" specifies for MONTHLY (no separate env var).
9. **LIVE `next_due_at` requeue** — LIVE variant job at `done` with `last_generated_at` stamped past `next_due_at` → variant job re-queued (`generation++`, `status='queued'`) regardless of state row status, per the per-variant cadence documented in §"Periodic report readiness".
10. **Archived → re-pending cycle** — window-replace removes all versions of a `story_id` → state `archived`; same `story_id` re-appears → state row reset to `pending` and prior dry-run job rows deleted (#294 decision 1).
11. **Reconciliation seed** — delete one state row after ingest, run reconciliation tick → row re-seeded; second tick reports zero changes (#294 decision 2).
12. **Generation cap exemption (dry-run)** — repeat dirty trigger past `ANALYSIS_MAX_GENERATION` on a dry-run job → cap not applied to dry-run rows, real-call jobs would still cap.

The synthetic suite is tracked in #326 (filed alongside this amendment as the round-12 follow-up). The 48h path remains a valid alternative until that suite lands.

### Phase 0.5 — Watermark (parallel, optional)

- **aice-web-next**: PR 3 — `cursor_event_time` + `cursor_quality` on envelopes.
- **aimer-web**: PR 4 — worker reads watermark, shortens DAILY settle.

Can run in parallel with Phase 1.

### Phase 1 — Story analysis

Goal: per-story LLM analysis, end-to-end.

- **aimer**: PR 5 — `analyzeStory` mutation (auth-mtls only, stateless) + `STORY_PROMPT`. No keyspace, no cache.
- **aimer-web**: PR 6 — worker calls `analyzeStory` on ready story jobs; result storage with priority tier; story detail page in aimer-web; force-regenerate UI; redaction integration.
- **aice-web-next**: PR 7 — story detail page deep-link badge.

Verification gate: story-analysis quality validated. Passed via **either** path:

- **(a) Operator-driven qualitative review**: 20–50 stories manually reviewed by an operator for quality; cost-per-story tracked; priority distribution sanity-checked (CRITICAL is neither 0% nor 90%).
- **(b) AI-proxy review** (preferred when operator time is constrained): produces a markdown report at `docs/verification/phase-1-gate-{YYYY-MM-DD}.md` covering:
  1. **Automated metrics**: priority-tier distribution across `story_analysis_result`; rates of `ai_analysis.factor_dropped`, `ai_analysis.ttp_tag_dropped`, `ai_analysis.hallucination_detected` from the audit log. **Cost is not gated by path (b)**: LLM token usage is not on the GraphQL wire today (`StoryAnalysisResult` does not carry it, and `story_analysis_result` does not store it) so the proxy reports `mean/median tokens per story` only when aimer-side LLM call logs are accessible at gate-pass time — best-effort. When unavailable, the artifact records `cost_proxy_available: false` and dollar-cost tracking falls back to the path (a) operator-tracked concern. Neither high token usage nor missing token data fails the gate.
  2. **Narrative scoring on a stratified sample of 15–25 stories** (across CRITICAL/HIGH/MEDIUM/LOW), each scored on (i) prompt adherence (kill-chain / lateral-movement / attacker-hypothesis questions answered), (ii) factor articulation quality vs §"Score factor articulation" rules, (iii) TTP tag plausibility vs MITRE descriptions, (iv) narrative coherence (no contradictions, redaction tokens preserved verbatim, no plaintext PII leaks), (v) score calibration vs proxy intuition.
  3. **Issues flagged by severity** (BLOCKER / WARNING / NOTE) with proxy-recommended pass/fail.
  4. **Human spot-check** (≤ 30 min): reviewer scans the proxy report's findings, randomly samples 3–5 unflagged stories to catch proxy blind spots, stamps the gate-pass.

Path (a) remains the authoritative fallback. The cumulative-confidence rule (see below) determines when subsequent phases may reduce the human spot-check.

### Phase 2 — LIVE + DAILY periodic reports

Goal: time-windowed digests covering stories + single events + baseline aggregates.

- **aimer**: PR 8 — `generatePeriodicSecurityReport(period, ...)` (auth-mtls only, stateless) + `PERIODIC_SECURITY_REPORT_PROMPT`. No keyspace, no cache.
- **aimer-web**: PR 9 — worker generates LIVE every 60min and DAILY at settle; baseline aggregator (counts, category distribution, delta-vs-previous); report view in aimer-web with priority-graded sectioning.
- **aice-web-next**: PR 10 — customer dashboard "Latest digest" and "Today's report" cards.

Verification gate: LIVE + DAILY report quality validated. Passed via **either** path:

- **(a) Real-environment 7-day observation**: 7 days of LIVE + DAILY in a real environment; reports should not be near-duplicates day-over-day (a sign of a dull prompt).
- **(b) AI-proxy review** (preferred when operator time is constrained): produces `docs/verification/phase-2-gate-{YYYY-MM-DD}.md` covering:
  1. **Automated metrics**: day-over-day `sections_jsonb` similarity — computed per-section by extracting the text under each key (`executive_summary`, `story_highlights`, `notable_events`, `baseline_observations`, `period_outlook` — the keys aimer's `PERIODIC_SECURITY_REPORT` schema emits; the array-valued sections are joined before comparison) and pairing consecutive days' values, then taking Jaccard 5-gram overlap on the `executive_summary` text (headline signal, low-template-noise). Similarity **> 0.85** flags near-duplicate; the other four sections are reported alongside for triage but do not gate on their own (those carry more template structure and shared phrasing). Plus: aggregate score variance per period; baseline-drift signal-to-noise (proportion of days drift materially shaped `priority_tier`); leaf-reference cardinality per report.
  2. **Narrative scoring on 5 daily reports + 2 LIVE snapshots**, each scored on (i) section-structure adherence (`executive_summary` / `story_highlights` / `notable_events` / `baseline_observations` / `period_outlook` present and distinct), (ii) leaf-reference accuracy (cited stories actually map to included `input_story_refs`; cited events to `input_event_refs`), (iii) TTP weaving (techniques referenced by ID in narrative match `aggregate_ttp_tags`), (iv) day-over-day distinctness (paraphrase rather than re-summarize is flagged).
  3. **Issues by severity** + proxy pass/fail recommendation.
  4. **Human spot-check** (≤ 30 min): same shape as Phase 1.

Path (a) remains the authoritative fallback. The round-12 acceptance-suite path (b) for Phase 0 does **not** carry over to Phase 2 — Phase 2's path (b) is the AI-proxy review defined here, not a deterministic fixture suite. The two path-(b)s have different shapes because Phase 0 is mechanical and Phase 2 is qualitative.

### Phase 3 — WEEKLY + MONTHLY

- **aimer**: same mutation; just new `period` values. PR 11.
- **aimer-web**: PR 12 — WEEKLY/MONTHLY workers; comparative framing in prompt (trend vs prior period); UI tabs for week/month.
- **aice-web-next**: no change (these are aimer-web-only by the "recency on dashboard" rule).

Verification gate: WEEKLY + MONTHLY comparative-framing quality validated. Passed via **either** path:

- **(a) Operator review**: weeklies do not read as concatenated dailies, monthlies frame against prior month.
- **(b) AI-proxy review** (preferred when operator time is constrained): produces `docs/verification/phase-3-gate-{YYYY-MM-DD}.md` covering:
  1. **Automated metrics**: comparative-framing marker rate (proportion of weeklies that explicitly reference prior week; same for monthly vs prior month); cross-period leaf-overlap ratio (a weekly should reference its week's daily leaves, not arbitrary leaves).
  2. **Narrative scoring on 2 weeklies + 2 monthlies**, each scored on (i) comparative-framing depth (identifies trend / resolved-vs-ongoing / week-over-week deltas, not a concatenated daily), (ii) technique-trend articulation (TTP frequency changes called out), (iii) executive-tier framing (longer-period reports do not read as raw event lists).
  3. **Issues by severity** + proxy pass/fail recommendation.
  4. **Human spot-check** (≤ 30 min): same shape as Phase 1/2.

Path (a) remains the authoritative fallback.

### Cumulative confidence (applies to Phase 1/2/3 path (b))

The agreement metric per gate pass is `human_confirmed / (proxy_flagged + human_added)`, where:

- `proxy_flagged`: items the proxy flagged (BLOCKER + WARNING; NOTE excluded).
- `human_confirmed`: proxy-flagged items the human agreed with after spot-check.
- `human_overridden`: proxy-flagged items the human disagreed with (proxy was wrong about severity or item entirely).
- `human_added`: items the human discovered during the spot-check sample that the proxy missed (any severity). This captures false-negative risk — without it, a silent proxy could trivially score 100% on the items it did flag while letting BLOCKERs slip past.

If agreement is ≥ 90% across **two consecutive** gate passes via path (b) **and** no `human_added` item was rated BLOCKER on either pass, the next phase's path (b) may proceed without a full spot-check — the human just stamps the proxy report's gate-pass recommendation.

The **next** gate reverts to path (a) regardless of operator availability when **either**:

- (i) any single gate pass shows < 70% agreement, **or**
- (ii) the human added a BLOCKER-severity finding the proxy missed on any pass (a single missed blocker is sufficient to revert — proxy reliability is on the line, not just calibration).

All four counts (`proxy_flagged`, `human_confirmed`, `human_overridden`, `human_added`) plus per-finding severity are recorded in each `docs/verification/phase-{N}-gate-{date}.md` artifact so the trail is auditable.

**Zero-denominator case** — when `proxy_flagged == 0 && human_added == 0` (both proxy and human spot-check find nothing on this pass), the agreement metric is `0 / 0`. Treat this as **insufficient calibration data**, not as 100% agreement:

- The pass itself counts as a successful gate pass (no issues found, gate passes normally).
- The consecutive-pass counter for the shrink rule does **not** advance — this pass produces no signal to evaluate proxy reliability against.
- The artifact records `agreement: null` with reason `"no findings on either side — pass succeeded but cumulative-confidence counter not advanced"`.
- Counting it as 100% would let two trivially-clean gates chain into the shrink rule without any actual proxy validation, defeating the rule's purpose; counting it as 0% would unfairly punish a clean dataset. Neither is correct — the honest answer is "no data to score, hold the counter".

Two consecutive **insufficient-calibration** passes still leave the next gate at full spot-check. The counter advances only when a path-(b) pass produces at least one finding to score (either side).

### Phase 4 — Polish

- Refresh-window dirty cascade visibility (per-variant-job "regenerated N times" badge with history; in the UI a single report card surfaces the max `generation` across its visible variants).
- Priority threshold admin UI.
- Cost / quality dashboards.
- User feedback 👍/👎 per result (aimer-web only).
- Translation strategy revisit (original-language + machine translation cache vs per-language regeneration).
- Generation cap monitoring + alerting.

The wholesale removal of aimer's auth-jwt surface is **out of scope for this RFC** — tracked as its own separate effort. It must not block any Phase 0–4 work here.

---

## Open questions

1. **Generation cap on force**: should user-initiated force also count against `ANALYSIS_MAX_GENERATION`? Tentatively no, but operators could abuse it. Revisit after Phase 1.
2. **LIVE storage shape**: storing LIVE results in the same `periodic_report_result` table with `period='LIVE'` and a synthetic `bucket_date` is convenient but mixes ephemeral with permanent. Alternative: a separate `live_report_snapshot` table with TTL. Decision deferred to PR 9.
3. **aice-web-next watermark for story**: cursor is `(created_at, id)` and late-commit stragglers exist. The `cursor_quality='soft'` flag exists for this, but it may be cleaner to omit the field entirely on story envelopes. Decide during PR 3 review.
4. **account.timezone change UI in aimer-web**: filed as separate task; do not block this RFC.
5. **Policy events**: this RFC defers them. When picked up, can the same `generatePeriodicSecurityReport` accept policy_event_aggregates as an additional input section, or does it need its own mutation? Probably the same mutation, but confirm when the time comes.

---

## Decision log (for change tracking)

- 2026-05-25: customer-level timezone chosen over account-level or system-fixed.
- 2026-05-25: dedup key `(aice_id, event_key)` confirmed sufficient; no payload_hash fallback needed.
- 2026-05-25: story analysis and periodic reports modeled as separate table groups rather than one polymorphic table — initially proposed as `story_analysis_job` and `periodic_report_bucket`, later split into `*_state` / `*_job` pairs per review round 3.
- 2026-05-25: aimer-web is the sole AI feature host; aice-web-next surfaces only deep links per §"What aice-web-next surfaces".
- 2026-05-25: baseline events never analyzed individually; only aggregated as input to periodic reports.
- 2026-05-25 (review round 2): `story.summary_payload` excluded from LLM input in v1; story-level redaction map deferred to a future RFC.
- 2026-05-25 (review round 2): customer timezone change does not dirty existing buckets; old-tz buckets are archived/superseded and new-tz buckets are created lazily (resolves PK conflict with prior wording).
- 2026-05-25 (review round 2): `first_member_at`, `created_at`, `processing_started_at`, `last_generated_at`, `next_due_at` added so readiness conditions (story 6h max-wait, LIVE 60min cadence) have concrete columns to read. After the round 3 split these distribute as: `first_member_at`/`last_member_at`/`created_at` on `*_state`; `processing_started_at`/`last_generated_at`/`next_due_at` on `*_job` (per-variant).
- 2026-05-25 (review round 2): `aggregate_threat_score` added to `periodic_report_result` with a documented derivation from max(story scores, event scores, baseline drift); resolves the prior gap where reports had no score to feed priority tiering. (Superseded by round 10: split into `aggregate_severity_score` + `aggregate_likelihood_score`.)
- 2026-05-25 (review round 2): `prompt_version`, `model_actual_version`, `input_hash` added to both result tables for drift attribution.
- 2026-05-25 (review round 2): force-regenerate API contract clarified — path call defaults to current tz + default lang/model; optional query params target specific variants.
- 2026-05-25 (review round 3): multi-event LLM inputs use deterministic scope-unique token rewrite (`<<REDACTED_TYPE_E{i}_NNN>>`) at prompt-build time; `input_event_refs JSONB` stored on result rows for demap. No new encrypted map introduced; existing per-event maps remain the source of truth.
- 2026-05-25 (review round 3): state and per-variant job split into two tables each (`*_analysis_state` / `*_analysis_job`, `periodic_report_state` / `periodic_report_job`). Source readiness lives at state level; per-variant work (queued/processing/done/failed, generation, attempts, force) lives at job level. Resolves the issue that one bucket row could not represent independent Korean/English generation counters.
- 2026-05-25 (review round 3): `analyzeStory` no longer takes `timezone` and is not keyed by `tz` in either aimer cache or aimer-web result PK. Story analysis output uses UTC; localized time strings are an aimer-web render-time concern. (Superseded in part by round 8: aimer holds no cache at all for `analyzeStory`, so only the aimer-web result PK matters.)
- 2026-05-25 (review round 3): deep-link summary endpoint generalizes the score field to `{score, score_kind}` (`threat` | `aggregate`) so periodic reports fit the same shape as per-event / per-story summaries. (Superseded by round 10: shape becomes `{severity_score, likelihood_score, score_kind}` with `score_kind ∈ {leaf, aggregate}`.)
- 2026-05-25 (review round 3): aimer mutations `analyzeStory` / `generatePeriodicSecurityReport` must always return `prompt_version` and `model_actual_version`; aimer-web stores them `NOT NULL`. Providers without a real `model_actual_version` substitute the requested `model` string.
- 2026-05-25 (review round 4): report-scope token rewrite added — periodic report input builder rewrites story-scope `E{i}` tokens (and event-scope tokens) found inside included `analysis_text` into report-scope `R{j}` tokens, indexed against the report's merged `input_event_refs`. Mechanism is recursive and supports future report-cites-report cases.
- 2026-05-25 (review round 4): force-regenerate is now strictly a variant-job operation; removed from the dirty-transition trigger list. State rows only become dirty when source data actually changes (refresh_window/backfill or stray late ingest).
- 2026-05-25 (review round 4): Phase 0 migration list updated to reflect the state/job split (`*_analysis_state` + `*_analysis_job` + result tables); stale `periodic_report_bucket` reference removed.
- 2026-05-25 (review round 4): force-regenerate wording in §"Variant selection" corrected — first-time variant generation inserts a fresh job row, does not transition the state row.
- 2026-05-25 (review round 5): dirty-transition rules split per state type — explicit triggers for `story_analysis_state` (late `story_member` ingest after `ready`) added; previous text only covered periodic buckets.
- 2026-05-25 (review round 5): timezone lifecycle wording updated to use the post-split table names (`periodic_report_state` / `periodic_report_job` / `periodic_report_result`); behavior of archiving the state row vs leaving job rows untouched made explicit.
- 2026-05-25 (review round 5): `PERIODIC_SECURITY_REPORT_PROMPT` token-preservation instruction explicitly references `R{j}` (the scope the prompt actually sees post-rewrite), distinguishing it from `STORY_PROMPT`'s `E{i}`.
- 2026-05-25 (review round 6): timezone-parameter listing in §"Customer-level timezone" corrected to exclude `analyzeStory`; aligned with §aimer changes (story analysis is timezone-independent at the aimer interface).
- 2026-05-25 (review round 6): dirty-transition intro generalized from "at least one `done` job" to "at least one job in `processing` or `done`" so the story-side rule (which fires while a variant is still processing) reads consistently.
- 2026-05-25 (review round 6): `ANALYSIS_MAX_GENERATION` guardrail re-scoped from "single bucket" to "single variant job" — both story and periodic variant jobs are subject to the cap, matching the post-split model. Force regenerate remains exempt.
- 2026-05-25 (review round 7): round 2 entry annotated to show post-round-3 column distribution between `*_state` and `*_job` tables; Phase 4 visibility item re-scoped from "per-bucket" to "per-variant-job" with UI rollup note. Status moved Draft → Accepted.
- 2026-05-25 (review round 8): all new aimer work scoped to **auth-mtls only and stateless**. The pre-existing auth-jwt surface is not modified by this RFC (deletion deferred to its own effort). Consequences: the originally-planned PR-1 (timezone in `ReportKey`, `generateReport` signature) is cancelled; new mutations (`analyzeStory`, `generatePeriodicSecurityReport`) drop the `force` parameter (no aimer cache to bypass) and drop the JWT exposure; force regenerate stays entirely an aimer-web-side concern. auth-jwt code may still be reused as in-process helpers (LLM client, prompt loader, redaction utilities).
- 2026-05-25 (review round 9): stale cache/keyspace references cleaned up — top-of-file metadata, architecture diagram, and Phase 1/Phase 2 bullets in §"Phased delivery" no longer suggest aimer holds a cache or keyspace for the new mutations. All remaining "cache" mentions are explicit negations ("no aimer-side cache", "no keyspace, no cache key") or refer to aimer-web's cache, not aimer's.
- 2026-05-26 (review round 10): `threat_score` split into two orthogonal axes `severity_score` and `likelihood_score` across all analysis result tables (`story_analysis_result`, `periodic_report_result` here; `event_analysis_result` in RFC 0001). `priority_tier` is now a deterministic 4×4 matrix lookup over the pair rather than a single-threshold formula. The previous `known_ioc_hit` / `member_count ≥ N` upgrade clauses fold into floors on `likelihood_score`, since each is evidence of being real, not of being severe. Floors apply only at matrix-lookup time; the stored `likelihood_score` always holds the LLM's raw estimate to preserve calibration data and let the floor policy evolve without rewriting history. `baseline_drift_score` similarly splits into severity and likelihood. Periodic report `priority_tier` is derived as `max(each included leaf's priority_tier, matrix(baseline_drift_severity, baseline_drift_likelihood))` rather than from the aggregate scores — this preserves leaf monotonicity (the report is never below the worst leaf in it) under the lookup-only floor policy, since the raw `likelihood_score` on leaves does not reflect floors. `aggregate_severity_score` / `aggregate_likelihood_score` remain stored as informational max-per-axis values for display and analytics. Summary endpoint shape becomes `{exists, priority_tier, severity_score, likelihood_score, score_kind, link}` with `score_kind ∈ {leaf, aggregate}`. LLM contract: `analyzeStory` and the RFC 0001 event-analysis mutation return both scores as separate `Float!` fields (camelCase `severityScore` / `likelihoodScore` on the GraphQL wire); `PERIODIC_SECURITY_REPORT_PROMPT` returns no scores (aggregation in aimer-web). A separate "LLM self-confidence" field was considered and rejected — `likelihood_score` is the domain-meaningful version of the same signal with better calibration semantics. Done before any production data accumulated; coordinated with RFC 0001 in the same PR.
- 2026-05-27 (Phase 0 amendment, #294): Force-regenerate URL shape amended from `POST /api/analysis/...` to `POST /api/customers/{customer_id}/analysis/...`. aimer-web has no server-side active-customer selector — `selectedCustomerId` lives in client-only React context and is never propagated server-side — so `customer_id` must travel on the wire. The customer-id-in-path convention is already established at the admin layer (`/api/admin/customers/[customerId]/...`); this amendment extends it to the non-admin analyst layer. `story_id`, `period`, and `bucket_date` are scoped under that customer's database.
- 2026-05-27 (Phase 0 amendment, #294): `story_analysis_state.status` enum extended to include `archived` (was `pending|ready|dirty`). The story side now mirrors the periodic side per decision 1 of #294: when every `story_version` of a `story_id` has been deleted from the customer DB by `refresh-window` or `backfill`, the state row transitions to `archived`. Unarchive-in-place is allowed: if the same `story_id` re-appears via a later window-replace, the state row UPDATEs back to `pending` with cleared timestamps and stale `*_analysis_job` rows from the archived run are deleted.
- 2026-05-27 (review round 12): Phase 0 verification gate redefined to accept either (a) real-environment 48h observation (unchanged) or (b) a deterministic acceptance suite covering every state-transition path documented in §"Readiness and scheduling" — twelve scenarios in total (story idle, story max-wait, story dirty cascade, periodic refresh-window overlap, periodic regular-batch dirtying a done bucket, DAILY settle, WEEKLY settle, MONTHLY settle, LIVE `next_due_at` requeue, archived → re-pending cycle, reconciliation seed cleanliness, generation cap dry-run exemption). Worker reads `NOW()` through a mockable seam so timers can be fast-forwarded deterministically. CI-green on the suite + manual review of one fixture run is equivalent to passing the 48h observation. Rationale: 48h's wall-clock cost was the dominant constraint in pre-release dev, and the verification value the 48h captured was an exhaustive run through documented transitions under timer firing, refresh-window cascade, late-event dirtying, LIVE cadence requeue, multi-period settle, and reconciliation second-pass — all reproducible deterministically once the time seam exists. Path (a) remains valid. Phase 1/2/3 gates are unaffected; they include qualitative content (operator review, near-duplicate detection, comparative framing) that a fixture cannot substitute. Acceptance suite implementation tracked in #326.
- 2026-05-28 (review round 13): Phase 1, Phase 2, and Phase 3 verification gates each redefined to accept either (a) the unchanged operator-driven qualitative review or (b) an AI-proxy review producing a structured markdown artifact at `docs/verification/phase-{N}-gate-{YYYY-MM-DD}.md` with automated metrics + narrative scoring on a stratified sample + flagged issues by severity, followed by a human spot-check ≤ 30 min that catches proxy blind spots and stamps the gate-pass. Path (a) remains the authoritative fallback. A cumulative-confidence rule allows the next phase's spot-check to shrink when proxy/human agreement has been ≥ 90% across two consecutive path-(b) passes **and** no BLOCKER-severity item was added by the human (false-negative kill switch), and forces a revert to path (a) when agreement drops below 70% on any pass **or** the human ever adds a BLOCKER-severity finding the proxy missed. Rationale: operator time is the dominant constraint in pre-release dev, the project is already driven by AI-assisted operations (AgentCoop for implementation, claude review for amendments), and round 12 set the precedent for gate alternative paths. Phase 0 gate is unaffected (its path (b) is the deterministic acceptance suite from round 12, a different shape from this round's AI-proxy because Phase 0 is mechanical and Phase 1/2/3 are qualitative). Round-12's claim that "Phase 1/2/3 gates are unaffected; they include qualitative content (operator review, near-duplicate detection, comparative framing) that a fixture cannot substitute" remains correct — round 13's AI-proxy is not a fixture and substitutes by structured human-assisted review, not deterministic execution. Path-(b) artifacts are committed under `docs/verification/` so the gate-pass trail is auditable.
- 2026-05-28 (Phase 1 amendment, #333): Story analysis deep-link surfaces (page + `summary` endpoint + `regenerate` endpoint) adopt a uniform **existence-hiding 404** policy for non-member denials. The page route already hid existence behind `notFound()` at merge; this amendment aligns the two API endpoints so a caller that is not a member of the customer receives `404 story_not_found` rather than `403`. Discriminator at the route layer: `authorize()` returns `{authorized: false}` with no `permissions` field for non-member (`authorizeGeneral` exits at the empty-row branch before building the permission set) and with a populated `permissions` set when the caller is a member without the required permission — non-member maps to 404, member-without-permission maps to precise 403 `Forbidden`. Bridge denials (`bridge_write_blocked`, `bridge_not_allowed`) keep their 403 contract because their reason codes leak only session-type, not story existence, and are already public per the #296 contract. The original spec bullet "Non-member viewers get 403" (RFC 0002 §"What aice-web-next surfaces" surface spec, surfaced by #296) is **retracted** by this amendment. Trade-off considered: 403 gives a clearer UX signal for analysts who picked the wrong customer in the UI, but `story_id` is a BIGINT likely monotonic within a deployment, and 403-vs-404 distinction lets a member of customer A enumerate story ids in customer B by probing for the membership-flip. The existence-hiding contract removes that probe oracle uniformly across UI and API surfaces — chosen as the cleaner contract for a multi-customer analyst console. The summary route's call switched from `assertAuthorized` (which throws a flat `HttpError("Forbidden", 403)`) to a direct `authorize()` call so the discriminator is observable; the regenerate route already used `authorize()` and only the denial branch changed. Deep-link table entry at §"What aice-web-next surfaces" updated in this round from `/analysis/story/{story_id}` to `/customers/{customer_id}/analysis/story/{story_id}` to match the implemented customer-scoped route (the summary endpoint URL at §"Force regenerate" was already customer-scoped).
- 2026-05-28 (Phase 1 amendment, #330): `known_ioc_hit` signal locked as a `BOOLEAN NOT NULL DEFAULT FALSE` column on `story`, populated at ingest time from an optional same-named field on the `phase2.story.v1` payload (omitted ⇒ `false`). The story worker reads it alongside the canonical story version and passes it into `applyLikelihoodFloors`. Phase 1 (#296) wired the floor through `applyLikelihoodFloors` but always passed `false`; this amendment closes the producer-side gap. Boolean rather than count, matching the floor's `max(stored, 0.95)` semantics. Column added inline to `CREATE TABLE story` per the pre-release dev-DB reset policy.
- 2026-05-27 (review round 11): Added MITRE ATT&CK TTP tagging and per-axis score factor breakdown to leaf-level analysis outputs. `ttp_tags` is an array of validated MITRE technique IDs (e.g. `"T1078"`, `"T1110.001"`); `severity_factors` and `likelihood_factors` are arrays of short noun phrases (`maxItems: 5`, `maxLength: 80` per item) articulating what drives each axis. All three are required on the LLM structured output and exposed as `[String!]!` on the GraphQL wire (`severityFactors` / `likelihoodFactors` / `ttpTags`): `ttpTags` may be empty (no clear MITRE mapping); factor arrays always contain at least one item, with `["insufficient evidence"]` reserved as the explicit thin-input sentinel and a post-filter empty-array recovery rule that substitutes the same sentinel when shape filters would otherwise produce an empty array (see §"Score factor articulation"). Stored as JSONB columns on `event_analysis_result` and `story_analysis_result`. `periodic_report_result.aggregate_ttp_tags` is the deduplicated sorted union of included-leaf tags; no aggregate factors column (periodic reports do not score themselves). MITRE data is vendored in aimer-web at `schemas/mitre-attack-techniques.json` + `schemas/mitre-attack.version`, refreshed manually like the aimer SDL — MITRE provides no live classification API, only static STIX bundles. Hallucinated TTP IDs are dropped server-side against the vendored list. Score factor articulation has shape-only validation (length, count, sentence-start filter) plus an `"insufficient evidence"` sentinel for genuinely thin inputs; content quality is governed by prompt engineering and Phase 4 per-factor feedback. Rationale for adding now: LLM structured-output JSON schema is being designed in #399 and an aimer-side `analyzeEvent` follow-up to #404; storage migrations land in Phase 0 (#294) and #308. Adding later would require LLM re-run on every existing analysis to backfill — the same backfill cost as round 10. Other improvements identified during the round-10 retrospective (workflow integration, follow-up Q&A, external TI enrichment, trend / fleet dashboards, vector similarity, PDF export, operator annotations) are pure additions and deferred to future RFCs / follow-up issues without structural impact.
- 2026-06-07 (review round 14): periodic-report leaf handling split into **coverage** and **calibration** to fix the model-migration gap (#379), where the implementation's strict same-`(model_name, model)` selection silently dropped leaves after a default-model change and produced empty/understated reports (observed on the gauntlet stack: 17 `gpt-4o` story leaves → 0 stories in a `gpt-5.5` report). **Coverage (never-drop):** leaves are selected by a deterministic preference order `[report model, then the model-catalog fallback order]`, with `lang` strict and `superseded_at IS NULL` unchanged; the fixed catalog order keeps selection (and `R{j}` token numbering) deterministic across regenerations. **Calibration (hybrid):** only the calibrated scores — `aggregate_severity_score`, `aggregate_likelihood_score`, and `report_priority_tier` — are computed from the **report-model subset** of the selected leaves (plus baseline drift); never fallback-model leaves, whose scores may be on a different scale. Everything that is not a calibrated score ranges over the **full** selected set: narrative/leaf sections and `aggregate_ttp_tags` (TTP tags are coverage facets, not scores). A coverage indicator (report-model count vs total, counts only per #386) discloses the transient post-migration understatement; it is derived read-time from `input_*_refs`, **not** a stored column (audit rows stay immutable). **Scope:** fallback applies only to default/system-seeded reports; explicit analyst alternate-model reports (A/B, #458) stay strict (honest-empty + regenerate CTA). Mixed-MAX was rejected because a single off-model leaf can dominate the `MAX` headline of a report labeled as model X. Data model: `periodic_report_result.input_story_refs` / `input_event_refs` now carry per-leaf `model_name` / `model` (additive JSONB payload, no DDL; refs lacking it read back as the report's model); the `R{j}` namespacing scheme is unchanged, but every reader (leaf/token restore, citation-variant resolution, reverse "Cited by" probe) must pin each leaf by its own ref's model rather than the report row's. The decision is recorded in #379; implementation is split into #465 (core coverage + hybrid scoring + per-ref read/restore) plus an operator-triggered, cost-bounded re-analysis cluster that shortens the transient understatement window: #466 (**story-leaf** backfill — coalescing enqueue), #470 (sibling **event-leaf** backfill — self-paced through the #463 single-event regenerate path, since events have no job/worker), and #469 (**report-variant refresh** — generation-bump, automatically gated on both leaf backfills' drain-completion signals). That cluster is launched in-app from a per-customer default-model change (#473, which also amends the §"Force regenerate" Default contract to a per-customer → admin-global → env resolution); it is human-triggered and never auto-run, cf. #374's one-time-cost concern. Leaf monotonicity is preserved over the report-model subset. Done before production data accumulated under the pre-release dev-DB reset policy.
- 2026-06-08 (closing notice): the RFC 0002 **core is delivered** — Phase 0 (foundations), Phase 0.5 (watermark), Phase 1 (story analysis), Phase 2 (LIVE + DAILY), Phase 3 (WEEKLY + MONTHLY), plus review rounds 10–14 — and the tracking umbrella (#292) is closed. The remaining open work is reclassified explicitly so the cycle boundary is unambiguous. **In-scope RFC 0002 follow-up (deferred, not core, no spec change required):** aimer-web #350 (batch analysis-summary endpoint), #374 (Phase 3 first-tick cold-start cost), and the operator-triggered model-change re-analysis cluster #466 (story leaves) / #470 (event leaves) / #469 (report-variant refresh) / #473 (per-customer default model); aimer #422 (cost tracking, round-13 deferred); aice-web-next #615 (Phase 2 enrichment), #664 / #665 (dashboard polish + metrics); tracking umbrellas aimer #402 and aice-web-next #647. **One in-scope RFC-body change remains pending:** #473 will amend §"Force regenerate → Default contract" to a per-customer → admin-global → env three-tier model resolution (as `(amendment, #473)`); the current §"Default contract" text is accurate for today's env-based behavior, so this is a future-feature amendment owned by #473's PR, not a gap. **Out of scope (a future RFC, not RFC 0002):** the Discussion #318 gap list — workflow integration, follow-up Q&A, fleet/trend dashboards, vector similarity, and related. This entry is bookkeeping only: no behavior, schema, or prior-decision change.
- 2026-06-08 (amendment, #473): The default analysis model — previously env-only (`ANALYSIS_DEFAULT_MODEL_NAME` / `ANALYSIS_DEFAULT_MODEL`) — becomes **DB-backed and per-customer with an admin-set global fallback**. §"Force regenerate" Default contract amended accordingly: `model_name` / `model` now resolve through `resolveDefaultModel(customer_id)` (`src/lib/analysis/default-model.ts`) in a strict three-tier order — (1) per-customer override (`customer_default_model` table, one optional row per customer), (2) admin-set global default (`system_settings` key `analysis_default_model`, value `{ modelName, model }`), (3) the unchanged env fallback (keeps existing deployments working when neither DB tier is set). `lang` is unchanged (env default only; not DB-backed). The resolver is async (it reads the DB) and therefore **replaces the default-resolution role of the synchronous `getDefaultModelPair()`**, which is re-scoped to env/catalog allow-list duties only (catalog membership); **every** default-omitting entry point routes through the resolver: worker seeding (`story-worker` / `report-worker` — seeded via a per-row `COALESCE(customer override, global, env)` join, since the old single-pair seed query shape no longer holds), the regenerate / summary / detail loaders, and the #465/#379 "default report → full leaf coverage" decision (computed per-customer so the coverage logic and the resolver never disagree). Catalog membership is enforced **twice**: the setter APIs block an out-of-catalog `(model_name, model)` at save (422), and the resolver is **defensive** — a stale/invalid stored value is logged and skipped to the next tier rather than 500ing. **Permissions:** global default = System Administrator only (`system-settings:*`); per-customer override = System Administrator (any customer, admin context) or an assigned Analyst (general context, via the analyst-assignment union); Manager and User denied (`customer-default-model:*` seeded to Analyst + System Administrator only). The per-customer override is **clearable** (delete the row → revert to the global default), exposed in both the API and the customer-settings UI. This is a **different layer** from the analyst per-artifact model selection (#458/#464): the per-customer default is the standing model new analyses use; per-artifact selection is a one-off override that does not change the customer default. Changing a customer's default affects **future** analyses only — existing results are untouched — and **offers** (never auto-runs) the scoped, cost-bounded re-analysis owned by #466/#470 → #469 for that customer (the model-change action is the entry point only). Filed as an issue, not a standalone RFC; this Decision-log entry plus the §"Force regenerate" Default-contract edit are the only RFC 0002 changes, in the `(Phase 0 amendment, #294)` style and **not** a new review round.
