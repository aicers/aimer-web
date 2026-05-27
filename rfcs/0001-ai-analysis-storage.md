# RFC 0001: AI analysis storage, redaction, and end-to-end flow

- Status: **Accepted**
- Authors: @sehkone
- Tracks: [#247](https://github.com/aicers/aimer-web/issues/247)
- Part of umbrella: [#44](https://github.com/aicers/aimer-web/issues/44) Phase 7: mTLS & Aimer Daemon Communication
- Server-side counterpart: aicers/aimer#384 (`analyzeEvent` stateless resolver — merged), aicers/aimer#388 (server-side redaction cleanup, blocked on this RFC's runtime landing)
- Background discussion: [Discussion #7](https://github.com/aicers/aimer-web/discussions/7)

## Summary

aimer-web (the BFF) ingests detection events from aice-web-next and sends them to the aimer daemon for LLM-based threat analysis via the mTLS pipe established in #228–#231. This RFC defines the end-to-end design: how ingested events are stored, how PII is isolated from the LLM through a redaction engine, how analysis results are cached and surfaced in the UI, and how the API between aice-web-next and aimer-web is shaped.

Two architectural decisions anchor the design. First, every ingested event's **LLM-bound canonical event content** is stored as **redacted plaintext + encrypted redaction map**. The redaction map (the only sensitive artifact) is encrypted via the existing DEK/KEK envelope; the rest of the row is plaintext JSONB and remains queryable. Per-event support JSONB and aggregate-level JSONB stay in their pre-existing plaintext-with-TDE form; redaction in v1 scopes precisely to what the LLM will see. Second, **aimer-web is the single source of truth for redaction**. aice-web-next sends raw event data over the existing encrypted bridge transport; aimer-web redacts the canonical content in-process before it touches disk and before any traffic leaves aimer-web for the aimer daemon. The aimer daemon receives only redacted text and returns analysis that references the same redacted tokens.

## Motivation

The mTLS pipe (#228–#231) and aimer-side `analyzeEvent` resolver (aimer#384) give aimer-web a secure transport and a stateless LLM analysis function. What is missing is the application-level contract: how do events get into aimer-web in a form safe to send to a third-party LLM, how are the resulting analyses stored and surfaced, and how does aice-web-next trigger and consume those analyses?

Three constraints shape the answer:

1. **PII protection from the LLM provider.** The LLM provider can log, learn from, or be compromised on inputs. Customer-identifying IPs, emails, and other entities must not flow to the LLM in raw form. The architecture must isolate PII at the BFF layer with a clear trust boundary.
2. **Greenfield with future-aware schema.** aimer-web has no production data to migrate. The schema choices made here will be the long-term storage shape for AI analysis, so they need to support cache reuse across model choices, per-language results, force re-analysis, retention with map cascade, and future resolver types — without preemptive abstraction that guesses at unknown shapes.
3. **Coordination across three repositories.** Changes land in aimer-web (this RFC's primary scope), aimer (cleanup of now-redundant redaction code), and aice-web-next (replace Phase 1 stub with real single-event payload, rewire the existing "Send to Aimer" button to call the new endpoint). The contract between the three must be stable before implementation work splits across them.

## Acceptance / status

The design captured here is the outcome of the discussion on #247 and reflects the decisions accepted there. The RFC document itself is in review until this PR merges, at which point the Status line above moves to `Accepted`. Implementation sub-issues filed under #44 reference the merged RFC as their spec. Open questions surfacing during implementation return here as RFC amendments.

---

## Storage model — unified across event-level ingestion paths (v1)

The core decision: every event ingested from aice-web-next is stored as **redacted plaintext + encrypted redaction map**. The original (with PII) is not stored as a separate encrypted blob — it is reconstructible from the two halves when needed.

### v1 scope: event-level only

The redaction map is keyed by `(aice_id, event_key)` — i.e. it assumes there is a single `event_key` per row, and a single PII variant per event. This pattern applies to the **canonical event payload columns** that carry the LLM-bound event content:

- Phase 1 `detection_events` (after per-event refactor — one row, one event)
- Phase 2 `baseline_event.raw_event`
- Phase 2 `story_member.event`
- Phase 2 `policy_event` event identity columns (`orig_addr`, `resp_addr`, `dns_query`, `uri`, `host`) and `policy_triage_snapshot`
- AI analysis results — `event_analysis_result` (per-event analysis, references the event's map)

### Per-event support columns — also out of scope for v1

`baseline_event` carries per-version support JSONB alongside the canonical `raw_event`: `score_window_context`, `window_signals`, `asset_context`, `scoring_weights_snapshot`. These are **not redacted in v1**. The exact rationale is documented in the SQL schemas section below; in short, `baseline_event`'s PK is `(baseline_version, event_key)` so the same `event_key` can have version-specific PII variants, and the `(aice_id, event_key)` map cannot represent that — and v1's LLM path does not send these columns anyway. They retain their current plaintext-with-TDE stance from RFC 0002 §11.1.

### Aggregate-level JSONB — also out of scope for v1

Two Phase 2 columns hold **aggregate-level** JSONB that has no single `event_key` to anchor a map to:

- `story.summary_payload` — story-level summary across all member events
- `policy_run.summary_stats` — run-level statistics

Under the current map key model these columns cannot be redacted (no key for the map row). v1 takes the pragmatic path: **these columns stay as today (plaintext JSONB, per RFC 0002 §11.1's existing decision)**, and the redaction storage refactor does not touch them.

This is consistent because:

- The v1 LLM flow uses only `analyzeEvent`, which takes a single event. `story.summary_payload` and `policy_run.summary_stats` are **never sent to aimer** in v1, so the LLM-exposure motivation that drove redaction does not apply to them.
- The existing plaintext-with-TDE stance for these columns is unchanged from today — v1 introduces no regression.
- When `analyzeStory` / `analyzePolicy` resolvers land in future aimer Phase 2+ (per aimer#383), those features ship with their own redaction model for aggregate columns — likely separate map tables keyed by `(aice_id, story_id, story_version)` and `(aice_id, run_id)` respectively. This is explicitly tracked in "Out of scope" below.

Consequences of the v1 scope:

- Encryption inconsistency between Phase 1 (encrypted blob) and Phase 2 event-level columns (plaintext JSONB per RFC 0002 §11.1) is resolved — both become redacted plaintext.
- Aggregate-level Phase 2 columns retain their current plaintext-with-TDE stance — no change.
- The RFC 0002 §11.1 'DB-level TDE assumption' remains load-bearing for the six Phase 2 columns not under redaction in v1: the four per-event support JSONB columns on `baseline_event` (`score_window_context`, `window_signals`, `asset_context`, `scoring_weights_snapshot`) and the two aggregate columns (`story.summary_payload`, `policy_run.summary_stats`). The redacted-storage refactor narrows the TDE risk footprint but does not eliminate it.
- Query/aggregate capability is preserved across all paths because the redacted form retains JSON structure.
- LLM-bound traffic uses the stored redacted form directly; no on-the-fly redaction needed per request.

## Redaction location — server-side (aimer-web) only

aimer-web performs redaction on receipt for every ingestion path. aice-web-next sends raw event data over the existing encrypted bridge transport (browser-mediated multipart POST over HTTPS with the two-JWS envelope, per RFC 0002); aimer-web applies the redaction policy in-process before the LLM-bound canonical event content touches disk. Support / aggregate JSONB columns that are out of scope for v1 redaction (listed in the Storage model section above) are persisted in their original plaintext form, just as they are today.

Reasons:

1. **Rule locality.** The customer-registered public IP range registry is server-side (`customer_redaction_ranges`). Sender-side redaction would force aice-web-next to either round-trip to fetch the current ranges on every send or maintain a synced copy — both fragile. Static rules (RFC 1918 ranges, regex patterns) could live on either side, but as soon as one rule is customer-configurable the server is the natural home for all of them.
2. **Trust boundary minimisation.** Keeping PII handling fully inside aimer-web means the sender never needs to know customer-specific privacy configuration. The raw event briefly exists in aimer-web's process memory and is then reduced to redacted plaintext + encrypted map on disk; the sender's role ends at delivery.
3. **Map locality.** The redaction map is the by-product of redaction. Generating it where the rules live means no on-the-wire map transmission and no question of whose copy is canonical.
4. **In-transit protection already exists.** The bridge transport is encrypted (HTTPS / mTLS depending on hop), so sending raw event data on the wire does not create a new exposure relative to the current Phase 2 flow that also sends plaintext JSONB.

Consequences:

- **RFC 0002 (Phase 2 wire contract) is unchanged.** aice-web-next does not modify its Phase 2 baseline / story / policy_run ingestion code. [aicers/aice-web-next#491](https://github.com/aicers/aice-web-next/issues/491) and its sub-issues continue against the same wire format.
- **The only aice-web-next data change** is the Phase 1 stub replacement (real single-event payload instead of `{"hello":"world","schema_version":"0.0-stub",...}`), which is orthogonal to the redaction location decision — it would be needed even if redaction were sender-side.
- **Storage refactor scope on aimer-web side:** the ingestion handlers gain a redaction step before persistence. Existing call sites of `encryptPayload` for Phase 1 are removed in favour of `redact + insert (redacted JSONB, separate map row)`; Phase 2 handlers add redaction in front of the existing JSONB inserts.

## Redaction engine — v1 policy

| Entity | Policy |
|---|---|
| IPv4 private (10/8, 172.16/12, 192.168/16, 169.254/16, 127/8) | Always redact |
| IPv6 private (fc00::/7, fe80::/10, ::1) | Always redact |
| IPv4/IPv6 public | Redact only if matched by a customer-registered range; otherwise pass through |
| Email addresses | Always redact (regex) |
| MAC addresses | Always redact (regex) |
| Hostnames / FQDN, usernames, URL path components | v1: not redacted |
| All categories | v2+: switch to AI-based privacy filter (OpenAI privacy filter or equivalent) |

Default behaviour for customers who have not registered any public IP ranges: **redact all public IPs**. This is the safe default that protects the customer until they explicitly opt into a narrower scope. The admin UI must surface this state clearly.

### Token format

Tokens follow a fixed shape so downstream scanning (LLM hallucination check) can distinguish them from raw text:

- `<<REDACTED_IP_NNN>>`
- `<<REDACTED_EMAIL_NNN>>`
- `<<REDACTED_MAC_NNN>>`

`NNN` is a per-event monotonic counter; identical entities within the same event collapse to the same token (so an attacker IP appearing 10 times produces one map entry and 10 occurrences of the same token).

### Redaction map shape

```json
{
  "<<REDACTED_IP_001>>": { "kind": "ip", "value": "203.0.113.5" },
  "<<REDACTED_EMAIL_001>>": { "kind": "email", "value": "alice@example.com" }
}
```

Serialised JSON, then encrypted via the existing DEK/KEK envelope (`src/lib/crypto/envelope.ts`) before storage.

### Shared map across ingestion paths — invariants

The same `(aice_id, event_key)` can arrive through multiple ingestion paths in any order — for example Phase 1 detection (ad-hoc Send-to-Aimer), then later Phase 2 baseline batch promotion, then later Phase 2 story membership. Each path writes its own redacted row but they all reference **one** map row keyed by `(aice_id, event_key)`. The token assignment in the map must therefore be stable across paths so that any redacted row's tokens always resolve.

The redaction engine enforces three invariants on writes that touch a shared map row:

1. **First writer creates, subsequent writers reuse.** When ingesting a row for an `(aice_id, event_key)` that already has a map, the engine **loads the existing map** and uses its `{value → token}` reverse index to redact this payload. Entities seen before resolve to the same token they got the first time; the new redacted row uses those pre-existing tokens.
2. **Append-only entity additions.** If this payload contains entities not in the existing map (the canonical payload from path B genuinely mentions an IP that path A's payload did not), the engine **appends** new `{token → value}` entries to the map (next free `NNN` counter per entity kind, preserving the per-event monotonic property). Existing entries are never reassigned, renumbered, or removed. The updated map is re-encrypted and UPSERTed.
3. **Token-value injectivity is preserved.** Each entity value gets exactly one token; each token resolves to exactly one value. The engine rejects (and audits) any attempt to write a map row where a value would map to two distinct tokens or a token would map to two distinct values — this should be unreachable in correct code and indicates a redaction bug.

Concurrency: a write that needs to update an existing map row acquires a row-level lock (`SELECT ... FOR UPDATE` on the `event_redaction_map` row, or `INSERT ... ON CONFLICT DO UPDATE` with a guarded merge) so concurrent ingestion of the same `(aice_id, event_key)` from two paths cannot interleave token assignments. The redaction policy version (engine + ranges) used to produce a write is recorded **on the referent row that was just written**, not on the map row — see "Policy version lives on the redacted referent rows" below for why. The retroactive re-redact job consults those row-level stamps to detect rows that need reprocessing after policy change.

What this invariant explicitly does **not** require: that the canonical event payloads from two paths be byte-identical. Two paths may legitimately serialise the "same" event slightly differently (different field ordering, supplementary fields, schema version drift). The map shares entities, not payloads.

## SQL schemas — new tables

### `event_redaction_map`

One row per ingested event, shared across all four ingestion paths.

```sql
CREATE TABLE event_redaction_map (
    aice_id           TEXT NOT NULL,
    event_key         NUMERIC(39, 0) NOT NULL,
    ciphertext        BYTEA NOT NULL,
    wrapped_dek       TEXT NOT NULL,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (aice_id, event_key)
);
```

**Customer scope is implicit in the DB choice.** `customer_db` is per-customer (one Postgres DB per customer); the `customer_id` / `external_key` is established by which pool the caller selects, not stored on the row. This matches the existing lookup convention documented in [src/lib/analysis/lookup.ts:50-58](src/lib/analysis/lookup.ts:50). Including `external_key` here would be redundant and create a drift risk against the actual scoping mechanism.

**The map row does not carry a `redaction_policy_version` column.** The map's content (token assignments) is append-only and policy-version-independent: a token that resolved to value V under policy P1 still resolves to V under policy P2 (Shared-map invariants 2 and 3 above). The map therefore has nothing to be "stale" with respect to.

Staleness is a property of **redacted referent rows** (the rows holding the actual redacted JSONB / text), not of the map. Each referent row carries its own `redaction_policy_version` recording the policy that was in force when that row's redacted content was produced. See the next sub-section.

### Policy version lives on the redacted referent rows, not on the map

**Why not on the map.** Under the shared-map model, the same map row is updated whenever any path ingests an `(aice_id, event_key)` — append-only. If the map carried a single `redaction_policy_version`, an UPSERT under a newer policy would overwrite the stamp on the map even though earlier-written redacted referent rows are still encoded under the older policy. The retroactive job would then see "map is current" and skip those stale referent rows. Bug.

**Where it lives instead.** Each redacted referent row carries `redaction_policy_version TEXT NOT NULL`. The retroactive re-redact job scans these row-level columns, finds rows whose policy_version differs from the current target, and re-redacts the row in place. The map row is touched only as a side effect (new entities may be appended; existing tokens never change).

Tables that carry the column:

- `detection_events` (after per-event refactor)
- `baseline_event`
- `story_member`
- `policy_event`
- `event_analysis_result` — the analysis_text is also redaction-policy-sensitive (it contains tokens and possibly leaked plaintext entities the LLM produced before re-redact). The retroactive job re-redacts `analysis_text` against current policy too.

**Format: composite `engine:<semver>|ranges:<sha256-short>`.** Two components combined with `|`:

- `engine:<semver>` — version of the redaction engine code (regex patterns, IP-range matching logic, token format). Bumped manually by developers when the engine changes. Example: `engine:1.0.0`.
- `ranges:<sha256-short>` — first 12 hex chars of the SHA-256 of the customer's normalised `customer_redaction_ranges` (sorted CIDR list serialised as JSON before hashing). Empty range set hashes to a fixed sentinel. Recomputed at row write time.

Example: `engine:1.0.0|ranges:a1b2c3d4e5f6`.

Why composite: the retroactive button can distinguish "engine policy changed → all customers' data stale" from "this customer's IP ranges changed → only their data stale". The job scans only the affected rows; the UI surfaces the two reasons separately so an operator who just added a CIDR sees a job that touches only their customer's rows, not a global re-process.

### `event_analysis_result`

One row per (event, language, model). `force` re-analysis upserts on the PK.

```sql
CREATE TABLE event_analysis_result (
    aice_id                  TEXT NOT NULL,
    event_key                NUMERIC(39, 0) NOT NULL,
    lang                     TEXT NOT NULL,        -- aimer wire value: 'KOREAN' or 'ENGLISH'
    model_name               TEXT NOT NULL,        -- BFF-supplied provider, e.g. 'openai'
    model                    TEXT NOT NULL,        -- BFF-supplied model id, e.g. 'gpt-4o'
    model_actual_version     TEXT,                 -- NULL until aimer reports the real snapshot
    prompt_version           TEXT,                 -- NULL until aimer reports the prompt template version
    severity_score           DOUBLE PRECISION NOT NULL,    -- 0.0–1.0; "if real, how bad" (impact, blast radius)
    likelihood_score         DOUBLE PRECISION NOT NULL,    -- 0.0–1.0; "how likely this is a real threat"
    priority_tier            TEXT NOT NULL
        CHECK (priority_tier IN ('CRITICAL', 'HIGH', 'MEDIUM', 'LOW')),   -- derived via 4x4 matrix; see RFC 0002 §"Priority tiering"
    analysis_text            TEXT NOT NULL,        -- redacted (tokens reference event's map)
    redaction_policy_version TEXT NOT NULL,        -- policy under which analysis_text was redacted
    requested_by             UUID NOT NULL,        -- accounts.id (auth_db cross-reference; not FK)
    requested_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (aice_id, event_key, lang, model_name, model)
);
```

**`model_name` and `model` are part of the cache key**, not just informational columns. The API accepts these in the request, so different model choices for the same event/language must produce distinct rows — otherwise a request for `gpt-5` would silently return a cached `gpt-4o` result. Cache hit therefore requires exact match on all five PK columns. `force=true` upserts on the same PK (replacing the row for that specific model combination, not all models).

`customer_id` / `external_key` is implicit in the customer DB choice (same convention as `event_redaction_map`).

`model_actual_version` (the LLM provider's specific snapshot — e.g. `gpt-4o-2025-05-13`) and `prompt_version` (aimer's prompt template version) are intentionally nullable. They are populated once aimer's response payload carries them (tracked as a separate aimer-side follow-up, not blocking this design); until then NULL records the "not reported by aimer at this time" state explicitly rather than fabricating a value. Scores arrive on the wire as `severityScore` and `likelihoodScore` per RFC 0002 §"Priority tiering"; both are `NOT NULL` on storage. `priority_tier` is a deterministic 4×4 matrix derivation per RFC 0002 §"Priority tiering", computed in aimer-web from the two scores at write time — it is not an LLM-returned value.

`lang` is stored exactly as it appears on the wire to aimer (the `Language` GraphQL enum from aimer#384: `KOREAN` | `ENGLISH`). UI mapping to `next-intl` locales (`ko` / `en`) happens in the presentation layer; the storage uses aimer's vocabulary so there is no translation layer between the row and the call.

`requested_by` is kept as informational metadata only. The audit log (`ai_analysis.request_issued`) remains the canonical, append-only source for "who triggered which analysis when"; the column on the row is for UI convenience (display "Requested by X" without joining the audit log per page load) and is treated as best-effort. The UI renders the stored value verbatim — there is no per-render lookup against the global accounts table and no `"deleted user"` substitution; the column crosses the customer-DB / global-DB boundary, so resolving it back to an account label is deferred to a follow-up issue once the requester-id semantics are settled. If the referenced account is later deleted, the row keeps the orphan UUID and the UI shows it as-is.

No `FOREIGN KEY` to `event_redaction_map` despite logical dependency: per RFC 0002 §5, analysis rows must outlive their source row across retention sweeps.

### `customer_redaction_ranges` (auth_db)

```sql
CREATE TABLE customer_redaction_ranges (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    customer_id       UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    cidr              CIDR NOT NULL,
    ip_version        SMALLINT NOT NULL CHECK (ip_version IN (4, 6)),
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_by        UUID NOT NULL,
    UNIQUE (customer_id, cidr)
);

CREATE INDEX customer_redaction_ranges_customer_id_idx
    ON customer_redaction_ranges (customer_id);
```

Validation rules in the API layer (not enforced at the DB level so error reporting can be graceful):

- Reject CIDRs that fall within RFC 1918 / IPv6 ULA / loopback ranges (those are always redacted anyway; storing them confuses operator intent).
- Normalise input (e.g. `203.0.113.5/24` → `203.0.113.0/24`).
- Reject duplicates and pure subsets of existing entries (e.g. adding `/24` when an existing `/16` already covers it).
- Cap at 100 entries per customer (operational sanity bound; raise if real demand emerges).

## SQL schemas — modifications to existing tables

### Phase 1 — `detection_events`

Semantic shift: one row currently represents a **batch of N events** (encrypted aggregate blob, `event_count > 0`). After the refactor, one row represents **exactly one event** (redacted JSONB, `event_count = 1` implicit). The ingestion endpoint splits an incoming N-event batch into N rows, each going through redaction independently.

Per-event column mapping (current → after):

| Column | Current | After |
|---|---|---|
| `id` | per-row UUID (a row = batch) | per-row UUID (a row = single event); still useful for direct row reference |
| `aice_id` | unchanged | unchanged |
| `event_key` | not present (inside encrypted payload) | **NEW** — `NUMERIC(39, 0) NOT NULL`. Extracted during redaction. Indexed for cache lookup and the cascade rule's join target |
| `payload BYTEA` + `wrapped_dek TEXT` | encrypted batch blob | **dropped**. Replaced by `redacted_event JSONB NOT NULL` for the single redacted event; encryption moved to `event_redaction_map` |
| `event_count` | `INTEGER > 0` | **dropped** (always 1 implicit per row). Ingestion endpoint's external response can still report the original batch's total count if useful |
| `payload_hash` | SHA-256 of batch | per-event hash kept for dedup of "did we already ingest this exact event?". Stored as TEXT |
| `schema_version` | unchanged | unchanged (per-event now) |
| `source` | `'bridge' | 'manual'` | unchanged |
| `connection_id` | bridge connection UUID | unchanged (multiple per-event rows can share the same connection_id when one bridge transfer carried multiple events) |
| `ingested_by` | accounts.id | unchanged |
| `created_at` | unchanged | unchanged (per-event ingestion time — the row's retention clock origin) |

Phase 1 unique constraint: `UNIQUE (aice_id, event_key)` enforces that the same event is not ingested twice into the same AICE environment. The duplicate-detection check on ingestion uses this to short-circuit before performing redaction.

`detection_events` gains `redaction_policy_version TEXT NOT NULL` recording the policy in force when the row's redacted content was produced. The retroactive job uses this for staleness detection (see the "Policy version lives on the redacted referent rows" sub-section above).

### Phase 2 — `baseline_event`, `story`, `story_member`, `policy_run`, `policy_event`

**Canonical event payload columns** are the v1 redaction targets:

- `baseline_event.raw_event` — the original event JSONB
- `story_member.event` — the member event JSONB
- `policy_event` typed event-identity fields (`orig_addr`, `resp_addr` as TEXT after the type change above; `dns_query`, `uri`, `host` already TEXT) — these contain entity values directly
- `policy_event.policy_triage_snapshot` — the triage snapshot JSONB, redacted because it carries the same event content the LLM would see

These columns live on rows that have a single `event_key`; the map row in `event_redaction_map` is keyed naturally.

**Per-event support JSONB columns are NOT redacted in v1.** Specifically: `baseline_event.score_window_context`, `baseline_event.window_signals`, `baseline_event.asset_context`, `baseline_event.scoring_weights_snapshot`. Two reasons:

1. **Map key incompatibility.** `baseline_event` PK is `(baseline_version, event_key)` — the same `event_key` can appear under multiple `baseline_version` values, each with its own per-version snapshot of context/signals/weights. A single map row keyed `(aice_id, event_key)` could not faithfully restore version-specific PII variants.
2. **Not on the LLM path in v1.** Only `analyzeEvent` is called, which receives a single event constructed from the canonical payload — not the per-version support snapshots. The LLM-exposure motivation that drives redaction does not apply.

These support columns retain their current plaintext-with-TDE stance from RFC 0002 §11.1.

When `analyzeStory` / `analyzePolicy` / future analysis variants need to send support data to the LLM, their issue introduces a richer map key (likely including `baseline_version` or kind discriminator). Tracked in "Out of scope" below.

**Aggregate-level JSONB columns** (`story.summary_payload`, `policy_run.summary_stats`) are explicitly **not** redacted in v1 — see "Aggregate-level JSONB — out of scope for v1" in the Storage model section above. They retain their current plaintext-with-TDE stance from RFC 0002 §11.1.

**`redaction_policy_version TEXT NOT NULL` column added** to each table that holds redacted canonical content: `baseline_event`, `story_member`, `policy_event`. (Tables that hold only aggregate or support JSONB — `story`, `policy_run` — do **not** get this column because they have nothing redacted in v1.) The retroactive job scans these row-level columns to detect staleness, not the map row's metadata.

Typed PII columns must change type to accommodate tokens:

| Table.column | Current type | After type | Reason |
|---|---|---|---|
| `policy_event.orig_addr` | `INET` | `TEXT` | tokens like `<<REDACTED_IP_001>>` do not fit `INET` |
| `policy_event.resp_addr` | `INET` | `TEXT` | same |

Existing indexes on these columns remain useful for exact-match lookup on the redacted value (e.g. "show all events where the redacted attacker IP is `<<REDACTED_IP_001>>`" within a customer's data set — still a meaningful query for grouping events by entity).

Other Phase 2 typed columns (`kind`, `category`, `primary_asset`, `raw_score`, etc.) are non-PII metadata and remain unchanged.

### `analysis_narrative`

Existing table. Two options for the implementation sub-issue to choose:

- **Retire** in favour of `event_analysis_result`. Migrate any existing rows (greenfield, so likely zero). Simpler long-term model.
- **Extend** — add the new analysis kinds to the existing `target_kind` enum and reuse. Closer to the original RFC 0002 §8 design.

Retire is recommended for a greenfield: `event_analysis_result`'s PK (aice_id, event_key, lang, model_name, model) is a better match for per-event analysis than `analysis_narrative`'s content-hash model.

## End-to-end flow — `Send to aimer for analysis` (button to be renamed)

User in aice-web-next clicks the renamed button on a specific event. The browser cannot reach `POST /api/analysis/analyze` directly: that route is session+CSRF-gated and `verifyOrigin`-protected, and aice-web-next is a different origin / site. Entry instead goes through a wrapping endpoint, `POST /api/analysis/analyze-bridge`, that accepts a signed multipart envelope via top-level navigation (the same transport pattern as the existing `/api/auth/bridge`) and then calls the merged analyze flow server-side. The full contract for the wrapping endpoint is documented in the next sub-section, "Cross-site transport mechanics"; this section sketches the user-visible flow.

```
aice-web-next browser                          aimer-web                                       aimer
─────────────────────                          ─────────                                       ─────
[Click on event X — customerId C, lang L, model_name N, model M, force=false]
       │
       │  Build hidden multipart <form>:
       │    method="POST"
       │    enctype="multipart/form-data"
       │    target="_blank"
       │    action="/api/analysis/analyze-bridge"
       │    fields: context_token, events_envelope, events_data, analyze_params_token
       │
       │  form.submit()  ──── top-level navigation, new tab ───▶
       │
       │                                       [POST /api/analysis/analyze-bridge]
       │                                       verifyContextToken(context_token)
       │                                       verifyEventsEnvelope(events_envelope, events_data, contextClaims)
       │                                       verifyAnalyzeParamsToken(analyze_params_token, contextClaims)
       │                                       Cross-binding asserts:
       │                                         params.context_jti  === contextClaims.jti
       │                                         params.payload_hash === envelopeClaims.payloadHash
       │                                         params.envelope_hash === base64url(sha256(events_envelope))
       │                                       Per-parameter validation (lang ∈ LANG_VALUES,
       │                                         external_key ∈ contextClaims.customerIds, etc.)
       │                                            │
       │                                            ├─ same-site re-entry with live general session?
       │                                            │     └─ runAnalyzeFlow(...)  ────────────▶  analyzeEvent
       │                                            │             │                            ◀──── result
       │                                            │             ▼
       │                                            │        302 view_url   [END — new tab lands on result page]
       │                                            │
       │                                            └─ cross-site (typical):
       │                                                  INSERT pending_connections
       │                                                  INSERT pending_analysis_requests (same transaction)
       │                                                  set connection_id cookie
       │                                                  302 /api/auth/sign-in?flow=bridge
       │                                                            │
       │                                                            ▼
       │                                                  [Keycloak — interactive sign-in or silent SSO]
       │                                                            │
       │                                                            ▼
       │                                                  [GET /api/auth/callback]
       │                                                    consume connection, create session
       │                                                    SELECT pending_analysis_requests by connection_id
       │                                                    PAR row present:
       │                                                      skip staged_event_customers insert
       │                                                      302 /api/analysis/analyze-bridge/continue?id=<par_id>
       │                                                            │
       │                                                            ▼
       │                                                  [GET /api/analysis/analyze-bridge/continue?id=<par_id>]
       │                                                    withGeneralAuth + authorize(...) against PAR's customer
       │                                                    PAR.status dispatch:
       │                                                      pending  → decrypt payload, runAnalyzeFlow,
       │                                                                 UPDATE PAR (consumed, view_url, consumed_at),
       │                                                                 302 view_url
       │                                                      consumed → 302 PAR.view_url (reload-safe)
       │                                                      failed   → styled error page from PAR.failure_code
       │                                                      expired  → styled "Session expired" page
       │
       │              [Original aice-web-next tab is preserved — no callback consumed]
```

`runAnalyzeFlow(...)` is the extracted core of the merged `POST /api/analysis/analyze` handler (event lookup, result cache lookup, redaction + ingest on miss, mTLS `analyzeEvent` call, hallucination scan, `event_analysis_result` UPSERT). Both `/api/analysis/analyze` and the wrapping endpoint call it; its behaviour matrix (cached / event-missing / force) is unchanged from the API contract below.

Force behaviour: identical except the lookup-cache step is skipped. The event itself is not re-redacted (event identity is the same); only the result is re-fetched and the row UPSERTed.

## Cross-site transport mechanics

The wrapping endpoint exists to bridge the gap between aice-web-next's cross-site browser context and aimer-web's same-site security model. This sub-section documents why a direct XHR cannot reach `/api/analysis/analyze`, what auth class the wrapping endpoint inhabits, the signed-payload contract that substitutes for session+CSRF, the OIDC continuation mechanism, and the storage isolation choice.

### Why a cross-site XHR to `/api/analysis/analyze` fails

Three independent gates make a direct `fetch('https://aimer-web/api/analysis/analyze', { method: 'POST', credentials: 'include', body: JSON })` from aice-web-next's browser non-viable:

1. **`verifyOrigin` rejection.** [src/lib/auth/guards.ts:233](../src/lib/auth/guards.ts#L233) rejects any request whose `Origin` header is not aimer-web's own origin. aice-web-next sends `Origin: https://<aice-web-next-host>`, which never matches — hard 403 before any handler runs.
2. **`SameSite=Strict` cookie isolation.** `setAuthCookies()` ([src/lib/auth/cookies.ts:122](../src/lib/auth/cookies.ts#L122)) sets `at`, `csrf`, and `token_exp` with `SameSite=Strict`. A cross-site request from aice-web-next carries none of these cookies even with `credentials: 'include'`, so `authorize(...)` has no session to evaluate and `verifyCsrf` has no cookie to compare against.
3. **Cross-origin `document.cookie` isolation.** Even if the CSRF cookie were somehow present, aice-web-next's JS (different origin) cannot read aimer-web's `document.cookie` to populate the `X-CSRF-Token` header. The same-origin policy blocks the read independent of cookie attributes.

All three are categorical: no combination of CORS headers, `credentials` modes, or cookie-flag relaxation makes the direct XHR work without dropping security properties that the same-site analyze callers rely on. The wrapping endpoint solves the problem at the transport layer instead — top-level navigation with a signed multipart envelope — rather than weakening `/api/analysis/analyze`'s gates.

### Wrapping endpoint auth class

`POST /api/analysis/analyze-bridge` is **not** session+CSRF-gated. `verifyOrigin` and `verifyCsrf` do not apply on this endpoint. It joins aimer-web's existing signed-multipart-authenticated pattern — the same auth class as `/api/auth/bridge`, which accepts cross-site multipart POSTs from aice-web-next over top-level navigation. The session+CSRF invariant remains the rule for the rest of aimer-web; the wrapping endpoint is an instance of the already-deployed exception, not a new exception class.

The substitution is "different security gate, already in production for the analogous endpoint," not "no security gate." Authenticity and integrity come from the JWS contract described next; the wrapping endpoint refuses any request whose envelope, context token, or analyze-params token fails verification or cross-binding.

`/api/analysis/analyze` itself is unchanged. Its three gates (`verifyOrigin`, `verifyCsrf({ ctx: "general" })`, `authorize(..., operationKind: 'process', bridgeScope)`) stay in place; the wrapping endpoint is the only new caller.

### Signed payload contract

The multipart body has four fields — the existing three from the Phase 1 bridge envelope plus one new field for the analyze parameters:

```text
context_token         (existing)
events_envelope       (existing — unchanged)
events_data           (existing)
analyze_params_token  (NEW — sibling JWS)
```

`event_data` is protected as today: the events envelope JWS carries a `payload_hash` claim binding it to `events_data`, and the context token's claims (customer scope, AICE identity, replay-prevention JTI) gate envelope acceptance. The new `analyze_params_token` is a sibling JWS that carries the analyze-specific parameters and cross-binds them to the envelope.

`analyze_params_token` JWS claims:

```jsonc
{
  "context_jti":   "...",      // must equal contextClaims.jti
  "payload_hash":  "...",      // must equal envelopeClaims.payloadHash
  "envelope_hash": "...",      // = base64url(SHA-256(events_envelope JWS bytes))
  "event_key":     "...",
  "lang":          "KOREAN",
  "model_name":    "...",
  "model":         "...",
  "force":         false,
  "external_key":  "..."
}
```

Verification order at the wrapping endpoint:

1. `verifyContextToken(context_token)` — existing helper.
2. `verifyEventsEnvelope(events_envelope, events_data, contextClaims)` — existing helper, unchanged.
3. `verifyAnalyzeParamsToken(analyze_params_token, contextClaims)` — new helper, structurally a copy of the envelope verifier with a different claim shape.
4. Cross-binding assertions: `params.context_jti === contextClaims.jti`, `params.payload_hash === envelopeClaims.payloadHash`, `params.envelope_hash === base64url(sha256(events_envelope))`.
5. Per-parameter validation (see below).

Per-parameter validation:

- `lang` — enum check against `LANG_VALUES` (`KOREAN` / `ENGLISH`); `lang_unsupported` on miss.
- `model_name` / `model` — non-empty string check only; semantic validity is delegated to the downstream aimer GraphQL call (matches `/api/analysis/analyze`'s existing approach — `z.string().min(1)`).
- `external_key` — required. Direct membership check against `contextClaims.customerIds`, which already carries the external-key list. `authorization_failed` on miss.
- `event_key` — required. The wrapping endpoint applies the same `event_key_mismatch` guard as `/api/analysis/analyze`: top-level `event_key` must equal the `event_key` parsed out of `event_data`.
- `force` — boolean type-check only.
- **`customer_id` (internal UUID) is not accepted on this endpoint.** Cross-site callers must use `external_key`. The analyze route's UUID path remains for same-origin callers where the session attests the customer directly.

**Why sibling JWS over an extended envelope.** The extended-envelope option would modify `verifyEventsEnvelope` ([src/lib/auth/events-envelope.ts](../src/lib/auth/events-envelope.ts)) — a security-critical hot path used by Phase 1 and Phase 2 multipart routes. The sibling-JWS option leaves that verifier untouched. Future routes that read only the envelope cannot accidentally trust analyze params (opt-in isolation: only the wrapping endpoint invokes `verifyAnalyzeParamsToken`).

**Why `envelope_hash` cross-binding (over plain `context_jti` + `payload_hash` only).** The two-field cross-binding is secure but relies on review to ensure both checks are present at every call site. Adding `envelope_hash` makes envelope-substitution attacks require a SHA-256 collision against the specific envelope JWS bytes — infeasible — and gives the sibling-JWS pattern the same "secure by construction" guarantee as an extended envelope.

**Key reuse.** `analyze_params_token` is signed by the same trust registry key as the envelope (same `kid`, same `alg`). The trust registry lookup result is memoized within the request so the second JWS verify is a cache hit — no race window, no extra round-trip.

### Endpoint contract surface

`POST /api/analysis/analyze-bridge`:

- **Request:** `multipart/form-data` with fields `context_token`, `events_envelope`, `events_data`, `analyze_params_token`. The first three are the existing bridge envelope shape; the fourth is new.
- **Success response:** HTTP `302` to `view_url` — **not** JSON. The same-site short-circuit (live general session, payload verified, `runAnalyzeFlow` runs synchronously) returns the 302 directly from the bridge POST handler. The cross-site path returns the final 302 from `GET /api/analysis/analyze-bridge/continue?id=<par_id>` after the OIDC round-trip; the intermediate 302s go to `/api/auth/sign-in?flow=bridge` and then to `/continue`.
- **OIDC continuation route:** `GET /api/analysis/analyze-bridge/continue?id=<par_id>` is the dedicated landing point after OIDC sign-in (instead of the existing Phase 1 `/` landing). It runs `withGeneralAuth` + `authorize(...)` against the PAR's customer, then dispatches on `PAR.status`.
- **Error surface:** styled error page rendered in the new tab — **not** the JSON `{ error: { code, message, retryable } }` shape used by `/api/analysis/analyze`. The 12 RFC 0001 error codes are reused for the page body, **plus** the bridge-specific `invalid_analyze_params_token` defined below — i.e. the bridge-side error surface is **13 codes total**.
- **Error taxonomy addition:** `invalid_analyze_params_token` — JWS-level failures and cross-binding mismatches on `analyze_params_token`. Distinct from `invalid_events_envelope` so diagnostics can separate the two.

### OIDC round-trip continuation

`/api/auth/bridge` today verifies the multipart envelope, stages the events payload keyed on `connection_id`, sets the `connection_id` cookie, and returns a 302 to `/api/auth/sign-in?flow=bridge`. The OIDC callback ([src/app/api/auth/callback/route.ts:286](../src/app/api/auth/callback/route.ts#L286)) creates the bridge session and redirects the user to `/` — it carries no caller-supplied "what to do next" state. For the analyze flow, the OIDC round-trip must resume at `runAnalyzeFlow` with the originally-verified analyze parameters, not on the default `/` landing.

The wrapping endpoint introduces a hand-off via a new `pending_analysis_requests` (PAR) row plus a dedicated `/continue` route:

1. **At the bridge POST handler** (cross-site path, no live session): in the same transaction that inserts `pending_connections`, insert a PAR row containing the verified context (`aice_id`, `external_key`), the verified analyze parameters (`event_key`, `lang`, `model_name`, `model`, `force`), and the encrypted `event_data` ciphertext (reusing `encryptPayload` from [src/lib/crypto/envelope.ts](../src/lib/crypto/envelope.ts)). `connection_id UNIQUE` enforces one analyze intent per bridge call.
2. **At the OIDC callback** (after session creation, before staged-events linkage): `SELECT id FROM pending_analysis_requests WHERE connection_id = $1`. **No status filter** — PAR row presence (regardless of status) is the signal that "this connection is an analyze intent." A row in `expired`/`failed` state must still route through `/continue` so its status can be surfaced; falling through to Phase 1 would incorrectly insert `staged_event_customers` rows for an analyze flow. When the row is present, the callback **skips** the `staged_event_customers` insertion (no approval-queue exposure for analyze flows) and 302s to `/api/analysis/analyze-bridge/continue?id=<par_id>` instead of `/`.
3. **At `/continue`** (GET): re-authorize the (now-authenticated) session against the PAR's customer; dispatch on `PAR.status`. On `pending`, decrypt the payload, assert `SHA-256(plaintext) === payload_hash` for defence-in-depth, call `runAnalyzeFlow`, update PAR to `consumed` with `view_url` and `consumed_at`, 302 to `view_url`. On `consumed`, 302 to `PAR.view_url` directly (reload-safe). On `failed`, render a styled error page from `PAR.failure_code`. On `expired`, render a styled "Session expired" page.

**Why a separate `/continue` route, not callback-inline.** Folding `runAnalyzeFlow` (which includes the multi-second aimer GraphQL call) into the OIDC callback would (1) mix auth concerns with multi-second LLM concerns in a single request; (2) prevent reload-based retry, since OIDC `code` is single-use; (3) force the analyze flow's 13 error codes to share an error path with `/deny?reason=...`, which is designed for auth denials. The cost of the separate route is one extra 302 hop, negligible against OIDC + LLM latency. Reload safety comes from the PAR.status state machine, not HTTP semantics.

**Live-session short-circuit.** When the wrapping endpoint sees a valid existing general-context session on the incoming request (cookie present, `authorize(...)` would pass), it **skips the OIDC round-trip and the PAR row** — it runs `runAnalyzeFlow` synchronously and 302s to `view_url` directly from the POST handler. Full Q2 payload verification (context token + events envelope + analyze-params token + three cross-binding assertions) **still runs** in this path; skipping it because a session exists would let any same-origin caller submit arbitrary `event_data` / `model` / `external_key` on the user's authority. The short-circuit only fires on same-site re-entry (e.g., an operator opening an analyze URL directly while already signed into aimer-web); for the primary cross-site path the session cookies do not travel (they are `SameSite=Strict`) and the request always takes the bridge + OIDC path. Subsequent cross-site clicks remain cheap because the IdP's own SSO (Keycloak silent re-auth via its session cookie) absorbs the OIDC dance with no interactive prompt.

### Storage isolation — separate `pending_analysis_requests` table

The PAR row is **not** stored in `staged_event_payloads`. The Phase 1 staging table is bound to a per-customer approval lifecycle (joined with `staged_event_customers`, with `pending`/`approved`/`rejected`/`expired` status surfaced through the operator approval UI via `listStagedEventsBySession`). Persisting "I'm waiting for OIDC + analyze to complete" rows in the same table conflates two distinct lifecycles, and the approval UI would either surface analyze-pending rows it should not, or require new filter predicates threaded through every reader.

`pending_analysis_requests` is therefore a dedicated table with ciphertext stored **inline** (reusing the same `encryptPayload` / `decryptPayload` primitives as `staged_event_payloads`, but its own row, its own status state machine — `pending`/`processing`/`consumed`/`expired`/`failed` — and its own cleanup helper). `processing` is the in-flight claim taken by `/continue` via a CAS UPDATE (`pending → processing`) before invoking `runAnalyzeFlow`, so two concurrent `/continue` GETs on the same PAR cannot both run the aimer call. `connection_id UNIQUE` enforces one analyze intent per bridge call, providing a layer of replay defence on top of `pending_connections.jti` uniqueness. TTL aligns with `pending_connections` (5 minutes), with a 24-hour grace before deletion of `expired` / `consumed` / `failed` rows for forensic purposes.

**Encryption reuse.** `encryptPayload` / `decryptPayload` in [src/lib/crypto/envelope.ts](../src/lib/crypto/envelope.ts) already abstract the AES-256-GCM + OpenBao Transit DEK wrapping. `pending_analysis_requests` calls the same primitives — no new crypto infrastructure, no key-management change — while keeping its row, status state machine, and reader path separate from `staged_event_payloads`.

#### Schema

```sql
CREATE TABLE pending_analysis_requests (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id   UUID NOT NULL UNIQUE
                  REFERENCES pending_connections(connection_id),

  -- Verified context (post-JWS, cached for /continue re-authorize)
  aice_id         TEXT NOT NULL,
  external_key    TEXT NOT NULL,    -- already validated against contextClaims.customerIds

  -- Verified analyze params (post-analyze_params_token JWS)
  event_key       TEXT NOT NULL,
  lang            TEXT NOT NULL,
  model_name      TEXT NOT NULL,
  model           TEXT NOT NULL,
  force           BOOLEAN NOT NULL,

  -- Encrypted event_data (reuses crypto/envelope.ts helpers)
  payload         BYTEA NOT NULL,    -- AES-256-GCM ciphertext
  wrapped_dek     TEXT NOT NULL,
  payload_hash    TEXT NOT NULL,     -- SHA-256(plaintext); equals envelope's payload_hash

  -- Lifecycle
  status          TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'processing',
                                    'consumed', 'expired', 'failed')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at      TIMESTAMPTZ NOT NULL,
  consumed_at     TIMESTAMPTZ,
  view_url        TEXT,              -- set on success
  failure_code    TEXT,              -- one of the 13 bridge error codes, set on failure
  failure_at      TIMESTAMPTZ
);

CREATE INDEX idx_par_cleanup ON pending_analysis_requests(expires_at)
  WHERE status IN ('pending', 'processing');
```

`connection_id UNIQUE` enforces one analyze intent per bridge call — duplicate POST attempts hit the unique constraint and are rejected. The verified context columns (`aice_id`, `external_key`) and verified analyze-params columns are populated from the JWS-validated values at insert time so `/continue` can re-authorize without re-running JWS verification on the resumed leg. `payload_hash` is stored to enable the defence-in-depth re-hash check at `/continue` after decryption.

#### Cleanup helper

Symmetric with `cleanupExpiredConnections`:

```ts
async function cleanupExpiredAnalyzeRequests(pool: Pool): Promise<number> {
  // Expire pending and stale processing rows past TTL
  await pool.query(
    `UPDATE pending_analysis_requests
     SET status = 'expired'
     WHERE status IN ('pending', 'processing') AND expires_at < NOW()`,
  );
  // Delete after 24h grace
  const result = await pool.query(
    `DELETE FROM pending_analysis_requests
     WHERE expires_at < NOW() - INTERVAL '24 hours'`,
  );
  return result.rowCount ?? 0;
}
```

`consumed` and `failed` rows are retained for the same 24h forensic window, then deleted. Stale `processing` rows past `expires_at` (e.g. a server crash mid-flow) are recovered by the same UPDATE pass that flips `pending` to `expired`. The partial index `idx_par_cleanup` covers both `pending` and `processing` so the expiry scan stays O(expiring rows) rather than O(table).

#### `/continue` dispatch state machine

`GET /api/analysis/analyze-bridge/continue?id=<par_id>` is the dedicated landing point after OIDC sign-in. Method is GET because the 302 from the OIDC callback naturally produces a GET; reload safety comes from the PAR.status state machine, not HTTP semantics. The `id` query parameter is a UUIDv4 lookup key, **not** a capability-bearing token — the session's account must still pass `authorize(...)` against the PAR's customer.

```text
GET /api/analysis/analyze-bridge/continue?id=<par_id>

1. withGeneralAuth — session required (callback created it).
2. Load PAR row by id; styled 404 page if not found.
3. Re-authorize: authorize(account, 'analyses:create', {
     customerId: <resolved from external_key>, aiceId,
     requiresAiceId: true, operationKind: 'process', bridgeScope,
   }) — styled 403 page on failure.
4. Status dispatch:
   - 'pending' or 'processing' AND expires_at <= NOW(): treat as
     expired regardless of stored status. Best-effort flip the row
     to 'expired' via CAS (`expireStalePAR`) and render the styled
     "Session expired" page. This enforces PAR TTL on the request
     path so the five-minute lifetime is independent of cleanup
     sweep cadence — without this gate, a /continue request that
     arrives after expires_at but before the next cleanup tick
     could claim and execute a stale row.
   - 'pending':
       a. claim via CAS UPDATE pending → processing **AND
          expires_at > NOW()**. If the claim fails, re-read
          PAR.status and dispatch on the new state (another
          /continue tick already advanced the row, or the row
          just crossed its TTL); skip the rest of this branch so
          runAnalyzeFlow is not invoked twice.
       b. decryptPayload(payload, wrapped_dek) → event_data plaintext
       c. assert SHA-256(plaintext) === payload_hash (defence-in-depth)
       d. runAnalyzeFlow({ event_data, event_key, external_key,
                          aice_id, lang, model_name, model, force })
       e. success → UPDATE PAR SET status='consumed', view_url=$1,
                       consumed_at=NOW() WHERE id=$par
                  → 302 to view_url
       f. failure → UPDATE PAR SET status='failed',
                       failure_code=$1, failure_at=NOW() WHERE id=$par
                  → styled error page (13 bridge error code branches)
   - 'processing' → styled "Analyzing…" page with meta-refresh
                    (another tick holds the claim; the page reloads
                    until the row transitions to consumed or failed)
   - 'consumed' → 302 to PAR.view_url (reload-safe)
   - 'failed'   → styled error page from PAR.failure_code
   - 'expired'  → styled "Session expired" page
```

**Defence-in-depth.** `/api/analysis/analyze`'s `(aice_id, event_key, lang, model_name, model)` cache means an accidental double execution of `runAnalyzeFlow` returns the cached result. PAR.status is the primary guard against re-execution: the CAS claim (pending → processing) ensures a single tick owns the flow even for `force=true` requests where the cache would not absorb a duplicate. The analyze cache remains the backup safety net.

## API contract — `POST /api/analysis/analyze`

### Request

```ts
{
  event_data: object,        // the actual event JSON; ignored if event already exists by key
  event_key: string,         // i128 cursor as decimal string; must match the event_key inside event_data
  customer_id: string,       // internal customer UUID
  aice_id: string,
  lang: "KOREAN" | "ENGLISH",  // matches aimer's Language enum wire value exactly
  model_name: string,        // LLM provider, e.g. 'openai'; passed through to aimer's `name`
  model: string,             // LLM model id, e.g. 'gpt-4o'; passed through to aimer's `model`
  force: boolean
}
```

The explicit `event_key` field is the canonical identifier for cache lookup. `event_data` must contain a parseable `event_key` field with the same value; the server rejects with `event_key_mismatch` (400) if they differ. This guards against a caller supplying an `event_data` whose internal event_key disagrees with the cache key, which would otherwise let the caller poison cache entries for unrelated events.

### Response

```ts
{
  view_url: string,          // absolute URL to the aimer-web result page
  cached: boolean            // true if returned from cache, false if a fresh analysis ran
}
```

### Authorization

`authorize(account, 'analyses:create', { customerId, aiceId, requiresAiceId: true, operationKind: 'process', bridgeScope })`. Both `customerId` and `aiceId` are required because the JWT minted downstream carries `aice_id` and the route must verify the caller has access to that environment, not only the customer.

### Behaviour matrix

| event | result | force | action |
|---|---|---|---|
| missing | — | — | redact + ingest + analyze + store result |
| exists | missing | false | analyze + store result |
| exists | exists | false | return cached view_url, skip aimer call |
| missing | — | true | redact + ingest + analyze + UPSERT result |
| exists | exists | true | analyze + UPSERT result (event ingestion skipped) |

### Errors

Failure response shape:

```ts
{ error: { code: string, message: string, retryable: boolean } }
```

`retryable: true` indicates a transient condition where the caller may safely retry without changing the request. UI surfaces this as a retry affordance; `false` indicates a configuration, validation, or terminal error that retry will not fix.

| code | HTTP | retryable | trigger |
|---|---|---|---|
| `invalid_event_data` | 400 | false | request body malformed or required field missing |
| `event_key_mismatch` | 400 | false | parsed event_key inside event_data does not match the explicit `event_key` field |
| `lang_unsupported` | 400 | false | `lang` is not in aimer's `Language` enum |
| `event_data_too_large` | 413 | false | payload exceeds the configured size cap (reuses `BRIDGE_MAX_PAYLOAD_BYTES`) |
| `authorization_failed` | 403 | false | `authorize()` denied; the response `message` carries the reason for operator audit but UI surfaces a generic denial |
| `aimer_auth_failed` | 502 | false | aimer returned 401 (`missing_authorization` / `invalid_token`); indicates mTLS/JWT contract drift, not a caller-fixable error |
| `aimer_invalid_request` | 502 | false | aimer rejected the GraphQL request with a validation error; indicates contract drift |
| `aimer_call_failed` | 502 | true | aimer returned 5xx or the GraphQL response carried a transient resolver error |
| `aimer_unavailable` | 503 | true | mTLS pipe down — cert expired, file paths unreadable, undici dispatcher refusing |
| `redaction_failed` | 500 | false | BFF redaction step threw before the aimer call; the bug must be fixed |
| `storage_failed` | 500 | true | DB write (event_redaction_map / event_analysis_result) failed; retry is reasonable for transient DB issues |
| `internal_error` | 500 | false | catch-all for unexpected exceptions |

LLM hallucination detection does not produce an error code: per the hallucination-handling decision above, the response is re-redacted and stored. Only the audit log entry signals the event.

`customer_redaction_ranges` empty / unregistered does not produce an error: the default "redact all public IPs" policy is safe to apply immediately.

## UI — analysis result page

Per the decision in this thread (option B), the result is shown in aimer-web's own UI, not embedded in aice-web-next.

- New page in aimer-web at the permalink URL: `/{locale}/customers/{customer_id}/aice/{aice_id}/events/{event_key}/analysis?lang={lang}&model_name={model_name}&model={model}`
    - `customer_id` (UUID) and `aice_id` are both in the path — same customer can be associated with multiple AICE environments, so the (customer, aice) pair is the minimum scope, and `event_key` is only unique within an `aice_id`.
    - `lang`, `model_name`, `model` are query parameters because they select the variant of the result. They are part of the storage PK, so all three are needed to resolve a specific row.
    - `customer_id`, `aice_id`, `event_key` are immutable — the URL is a permanent permalink. Switching `lang` or `model` queries different variants without changing the canonical resource path.
    - Route loader uses `customer_id` from the path for the `authorize()` call directly (no reverse lookup); rejects callers without access at the route gate.
- On load: authorize the caller against the event's customer (same `authorize()` call as the analyze route, with `operationKind: 'read'`).
- Fetch `event_analysis_result` row by `(aice_id, event_key, lang, model_name, model)` within the customer_db (customer scope already established by the route's `customer_id` path segment).
- **Always restore tokens for any UI display.** The redacted form exists for exactly two purposes: persistence in `analysis_text` / ingestion JSONB, and outbound traffic to the LLM (aimer). The UI never shows redacted tokens to an end user. Decrypt the corresponding `event_redaction_map` row and substitute every `<<REDACTED_*>>` token in `analysis_text` with its original entity before rendering. Callers without access to the customer are rejected at the route layer before any DB read; callers who pass the route gate are authorized to see the original entities by definition. There is no "view redacted" UI mode and no permission tier inside the UI that hides original values from someone who already loaded the page.
- Display: priority tier badge, both `severity_score` and `likelihood_score` (each `0.0–1.0`, with axis labels), restored analysis narrative, `model_name` + `model` (+ `model_actual_version` / `prompt_version` if present), requested-by, requested-at, force-re-run button.
- `<<UNVERIFIED_*>>` markers are rendered with a visual indicator (badge, tooltip) noting LLM hallucination origin. These are not restored (there is no original to restore to); the UI labels them explicitly.

The button in aice-web-next opens this page in a **new tab** so the operator does not lose aice-web-next context.

## Customer IP range registration UI

- New section in customer settings: `Redaction Ranges`
- List view of registered CIDRs with delete buttons
- Add form (single CIDR input, IPv4 or IPv6, validated client-side then server-side)
- Status banner if no ranges registered: "No public IP ranges registered. All public IPs are being redacted by default."
- Separate `Apply to existing data` button with a confirmation modal showing row count and estimated duration; clicking triggers an async re-redact job (one job per customer at a time, idempotent if re-clicked).

### Permissions

Introduce two new permission keys with a seed migration. Earlier consideration of reusing `customer-settings:*` is rejected because the existing seed grants `customer-settings:*` to Manager only ([`migrations/auth/0003_roles.sql:52`](migrations/auth/0003_roles.sql:52)), and the access requirement here is **general members read, Manager-level write**. Adding `customer-settings:read` to User / Analyst would over-extend access to unrelated settings under the same key; a separate key is cleaner.

| Permission key | Required for | Granted to (seed) |
|---|---|---|
| `customer-redaction-ranges:read` | View list of registered CIDRs, default-behaviour banner | User, Analyst, Manager, System Admin |
| `customer-redaction-ranges:write` | Add / remove CIDRs, trigger `Apply to existing data` retroactive job | Manager, System Admin |

The seed migration adds these to the existing role rows and is part of implementation sub-issue 1 (schemas + permission audit).

## aimer-side coordination — aimer-web is the single source of truth for redaction

aimer#384's `redact_event_string` and `restore_analysis_pii` are removed. aimer-web becomes the single source of truth for redaction: all events sent to aimer are already in their final redacted form, and aimer's response is consumed as-is (with the hallucination scan described below).

Tracked on the server side as aicers/aimer#388. The removal is **blocked by aimer-web's redaction implementation landing in production** — until aimer-web reliably redacts upstream, the server-side pass must remain so that PII does not reach the LLM if any caller (test, debug, future variant) sends unredacted text. Order:

1. aimer-web's redaction engine + `POST /api/analysis/analyze` deployed.
2. Cross-check: live traffic confirms aimer-web is the only `analyzeEvent` caller and always sends redacted text.
3. aimer-side removal lands.

Rationale for removal rather than defense-in-depth:

- Single source of truth — redaction policy lives in one place. Two places means policy drift risk (one side updates patterns, the other doesn't) and confused failure modes (which side suppressed what?).
- aimer-web owns the redaction map (needed for restoration anyway), so aimer's redaction pass would be making a different map that nobody consumes — wasted work.
- Cleaner separation of concerns: aimer is a stateless analysis function, not a privacy layer.

## LLM hallucination handling

The `analyzeEvent` response is scanned with the same redaction patterns before storage. Matches indicate the LLM emitted entities not present in the original input (training-data residue or hallucination).

Action on match:

- Substitute matched text with `<<UNVERIFIED_IP_NNN>>`, `<<UNVERIFIED_EMAIL_NNN>>`, etc.
- **Counter scope: per-response.** `NNN` resets to `001` for each `analyzeEvent` response. Tokens have no meaning outside the single response they were generated in (these markers point to "the LLM said this entity but the original input did not contain it"; cross-response correlation is not meaningful).
- These markers are intentionally distinguishable from `<<REDACTED_*>>` so the UI can render them with a different visual treatment.
- Append an entry to the audit log: `ai_analysis.hallucination_detected` with target `(customer_id, aice_id, event_key)` (customer_id added so the audit trail is searchable across customer_db scope), pattern kind, and occurrence count.
- Operators can monitor `ai_analysis.hallucination_detected` frequency over time. Sustained rate above a threshold is a signal to switch model or prompt.

## Audit logging — new actions

- `ai_analysis.request_issued` — every `analyze` call (cache hit or miss), with `customerId`, `aiceId`, `eventKey`, `lang`, `force`, `cached`.
- `ai_analysis.result_stored` — successful UPSERT, with model/prompt versions.
- `ai_analysis.aimer_call_failed` — transport or 5xx from aimer.
- `ai_analysis.hallucination_detected` — see above.
- `customer_redaction_ranges.added`, `customer_redaction_ranges.removed` — config audit.
- `customer_redaction_ranges.retroactive_started`, `customer_redaction_ranges.retroactive_completed`, `customer_redaction_ranges.retroactive_failed` — job lifecycle.

## Retroactive re-redact job — design notes

- One job per customer at a time. Concurrent triggers are coalesced.
- Scans the four ingestion tables (`detection_events`, `baseline_event`, `story_member`, `policy_event`) plus `event_analysis_result` in the customer's `customer_db` for rows whose **own** `redaction_policy_version` column differs from the current target policy. The map row's metadata is **not** the staleness oracle — see "Policy version lives on the redacted referent rows" in the SQL schemas section for the rationale.
- For each stale row: decrypt the corresponding map row, reconstruct the original entity values for the tokens already present, re-redact this row's content with the current policy (which may add new tokens for entities the old policy missed), write the updated row + updated map (append-only on the map; existing tokens preserved per the shared-map invariants), stamp the row's `redaction_policy_version` with the current value.
- `event_analysis_result` rows are re-redacted in place too (the LLM may have leaked plaintext entities into `analysis_text`; current-policy redaction catches them). Re-redacting an analysis is purely a text substitution — the LLM is not re-called, so this is cheap and preserves the cached analysis.
- Cursor-based progression so a process restart resumes from the last successfully processed row instead of starting over.
- Cancellable from the admin UI; `status = 'cancelled'` halts the worker on its next progress checkpoint.

### `redaction_jobs` schema (auth_db)

```sql
CREATE TABLE redaction_jobs (
    id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    customer_id                 UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    status                      TEXT NOT NULL
                                CHECK (status IN ('queued','running','completed','failed','cancelled')),
    target_policy_version       TEXT NOT NULL,    -- the policy this job brings rows up to
    total_rows                  BIGINT,            -- known after initial scan
    processed_rows              BIGINT NOT NULL DEFAULT 0,
    failed_rows                 BIGINT NOT NULL DEFAULT 0,
    -- cursor (resume point on process restart)
    last_processed_aice_id      TEXT,
    last_processed_event_key    NUMERIC(39, 0),
    last_progress_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    started_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at                TIMESTAMPTZ,
    error_message               TEXT,              -- populated on 'failed'
    triggered_by                UUID NOT NULL      -- accounts.id
);

-- At most one active job per customer; re-clicking the button returns the existing one.
CREATE UNIQUE INDEX redaction_jobs_one_active_per_customer
    ON redaction_jobs (customer_id)
    WHERE status IN ('queued', 'running');
```

The cursor columns let the worker resume mid-stream after a crash or deploy. The scan operates inside the customer's `customer_db` (customer scope already pinned by the job's `customer_id` column); order is `(aice_id, event_key)` ascending; on restart the worker continues with `WHERE (aice_id, event_key) > (last_processed_aice_id, last_processed_event_key)`.

Job infrastructure scope: minimal — a single in-process worker per aimer-web instance is sufficient at this stage. Distributed scheduling is out of scope; multi-replica deployments coordinate via a Postgres advisory lock keyed on customer_id so only one replica drives each customer's job.

## Retention

All stored data is subject to retention with tiered defaults and per-customer override. The defaults reflect the relative cost of regenerating each kind of data: ingested events can be re-ingested by the upstream (`aice-web-next` re-sends if needed), while analysis results required a paid LLM call.

| Data class | Default retention |
|---|---|
| Phase 1 `detection_events` | 12 months |
| Phase 2 (`baseline_event`, `story`, `story_member`, `policy_run`, `policy_event`) | 12 months |
| `event_analysis_result` | 36 months |
| `event_redaction_map` | derived — kept while **any** referencing row (ingestion or analysis) is still within its retention; deleted only when no row references the `(aice_id, event_key)` pair any more |

### `customer_retention_policy` (auth_db)

Per-customer override of the defaults. One row per customer; auto-inserted at customer provisioning time with the defaults above.

```sql
CREATE TABLE customer_retention_policy (
    customer_id     UUID PRIMARY KEY REFERENCES customers(id) ON DELETE CASCADE,
    ingestion_days  INTEGER NOT NULL DEFAULT 365   CHECK (ingestion_days >= 30),
    analysis_days   INTEGER                         CHECK (analysis_days IS NULL OR analysis_days >= 30),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_by      UUID NOT NULL
);
```

- `analysis_days = NULL` means "no expiry" — administrators can opt into permanent retention if regulatory or operational policy requires.
- Minimum 30 days on both — prevents an operator from accidentally deleting data within a single business cycle.

### Clock origin

The retention clock starts at the moment the row enters aimer-web, not the moment the underlying event happened. Specifically:

| Table | Clock column | Why |
|---|---|---|
| `detection_events` | `created_at` | Phase 1 — ingestion time |
| `baseline_event`, `story`, `story_member`, `policy_run`, `policy_event` | `received_at` | Phase 2 — ingestion time, columns already in current schema |
| `event_analysis_result` | `requested_at` | Last analysis time. `force` re-analysis UPSERTs the row and refreshes the clock, so actively used analyses keep extending their lifetime automatically |
| `event_redaction_map` | (no own clock) | Lifetime determined by cascade rule above |

Choosing ingestion time (rather than the event's own `event_time` / `time_window_end`) is deliberate:

- **Phase 1 / Phase 2 uniformity.** Phase 1 `detection_events` does not surface the event's own time as a plaintext column (it lives inside the redacted JSONB after the storage refactor). Using ingestion time keeps the sweeper SQL identical across all four ingestion tables.
- **Backfill safety.** An operator who back-fills a year-old event into Phase 2 gets a full retention window from the backfill moment, not "this row is already past retention the instant it arrives". Retention measures aimer-web's custody duration, not the underlying event's age.
- **SOC convention.** "Data is retained for N months from receipt" matches typical compliance phrasing.

Edge cases worth recording:

- **Event expires before its analysis.** With defaults (12 months ingest, 36 months analysis), this is common. The cascade rule keeps the redaction map alive while the analysis row exists, so the analysis UI still restores tokens. The original event itself is gone — the UI surfaces this explicitly ("source event removed by retention; analysis result preserved").
- **Force re-analysis resets the analysis clock, never the event clock.** The two timers are independent. A force on a 35-month-old analysis pushes its expiry out another 36 months, but does not extend the underlying event's expiry.
- **Force re-analysis on an already-deleted event.** The API contract requires `event_data` in the request, so aice-web-next re-ingests as part of the call. If aice-web-next no longer holds the source data, the call fails with `invalid_event_data` (existing error code; no new failure mode).
- **Same event, different languages.** Each `(event, lang)` row is independent — one language's analysis can expire while another's persists, each tracked by its own `requested_at`.

### Map cascade rule

The redaction map's lifetime is the union of its referents. Concretely, on a sweep tick the map row is deleted only if **both**:

1. No row exists in any of the four ingestion tables for that `(aice_id, event_key)`, **and**
2. No row exists in `event_analysis_result` for that `(aice_id, event_key)`.

This guarantees the UI's token-restoration path always finds a map for any visible row, regardless of which side outlives the other.

### Sweeper

The actual deletion worker is **out of scope for this design** (filed as a separate sub-issue alongside the implementation work). v1 ships with the policy stored and the UI editable; the sweeper lands before the first customer's data reaches its retention horizon (no urgency at deploy — 12 months from first ingestion).

### Permissions

Same shape as redaction ranges — introduce dedicated keys via seed migration. `customer-settings:*` is Manager-only in the current seed and the access requirement here is also "general members read, Manager-level write".

| Permission key | Required for | Granted to (seed) |
|---|---|---|
| `customer-retention:read` | View current retention settings | User, Analyst, Manager, System Admin |
| `customer-retention:write` | Edit `ingestion_days` / `analysis_days` | Manager, System Admin |

### UI

Customer settings: `Data Retention` section.

- Two number inputs (Ingestion days, Analysis days). Blank Analysis = "Unlimited" with an explicit toggle next to the input.
- Confirmation prompt on shortening either value (data older than the new threshold will be deleted on the next sweep tick).

## Out of scope (deferred to future design)

- aimer-web standalone entry flow for users who never came through aice-web-next (will be designed together with the broader "event list / search / detail" UI in aimer-web).
- v2 AI-based privacy filter (OpenAI privacy filter or equivalent).
- v2 automatic retroactive re-redact on range addition.
- **Storage for other aimer resolvers' results** (beyond `analyzeEvent`). v1 ships `event_analysis_result` for the single resolver and **does not preemptively abstract**. When a second resolver (`analyzeStory`, `analyzePolicy`, …) lands, that issue's design decides whether to extend the existing table with a `result_type` discriminator or to add a parallel table — driven by the actual shape of the new result rather than a guess made now.
- **Aggregate-level JSONB redaction** for `story.summary_payload` and `policy_run.summary_stats`. The v1 map key `(aice_id, event_key)` does not accommodate row keys that have no single `event_key` (story_id+story_version, run_id). These columns stay plaintext in v1 (no regression from today) and are not sent to aimer because v1 only calls `analyzeEvent`. When `analyzeStory` / `analyzePolicy` ship in future aimer Phase 2+, the design for those features must introduce a story-level map (keyed by `aice_id, story_id, story_version`) and a run-level map (keyed by `aice_id, run_id`) — either as separate tables or as a generalised `redaction_map` with a discriminator. Tracked alongside the relevant resolver issue when it is filed.
- IP enrichment (geo/ASN/threat intel metadata) prior to LLM call. Possible v3 addition; orthogonal to the redaction policy.
- Customer-side hostname / FQDN registration for redaction. Same rationale as IP ranges but deferred until a concrete need surfaces.
- **Retention sweeper implementation**. The policy and per-customer storage land in v1; the actual deletion worker is a separate sub-issue filed after this design. v1 deployment has no urgency (12-month minimum default), so the sweeper has months of runway.

## Implementation sub-issue breakdown (suggested)

After this design lands, the work is split into smaller shippable units. Each should be a single PR that compiles and tests independently.

| # | Title | Scope | Depends on |
|---|---|---|---|
| 1 | Schemas + permission seeds | All new tables (`event_redaction_map`, `event_analysis_result`, `customer_redaction_ranges`, `customer_retention_policy`, `redaction_jobs`). Existing-table column changes: Phase 1 `detection_events` per-event restructure; Phase 2 `policy_event.orig_addr`/`resp_addr` `INET → TEXT`; add `redaction_policy_version TEXT NOT NULL` to `detection_events`, `baseline_event`, `story_member`, `policy_event` (and the new `event_analysis_result`). Add and verify dedicated permission seeds for `customer-redaction-ranges:read/write` and `customer-retention:read/write` (User/Analyst/Manager/Admin for read, Manager/Admin for write) | — |
| 2 | Redaction engine module | Pure module: regex scanning, IP/CIDR matching, customer range loading, token assignment, map structure. Unit tests cover policy completely. No DB writes, no HTTP | 1 (schemas referenced by tests) |
| 3 | Phase 1 ingestion refactor | Convert `/api/events/ingest` and the bridge consume path to per-event row writes with redaction. Includes the `event_count` semantics shift and the new per-event response shape | 2 |
| 4 | Phase 2 ingestion refactor | Apply redaction in the four Phase 2 handlers (`/api/phase2/baseline/batch`, `/api/phase2/story/batch`, `/api/phase2/policy-run`) before persisting JSONB. No wire-contract change | 2 |
| 5 | Customer redaction ranges admin API + UI | CRUD endpoints + Customer Settings UI section + retroactive job trigger button | 1 |
| 6 | Retroactive re-redact job | Worker module, `redaction_jobs` lifecycle, advisory-lock coordination, cursor-based resume, audit emissions | 1, 2 |
| 7 | Customer retention settings UI | Form for `ingestion_days` / `analysis_days` under Customer Settings | 1 |
| 8 | Analysis flow — `POST /api/analysis/analyze` + storage + UI page | `event_analysis_result` writes, the new endpoint, hallucination scan, mTLS GraphQL client wiring to `analyzeEvent`, result view page at the permalink | 1, 2 |
| 9 | Retention sweeper | Background worker enforcing per-customer retention with the map cascade rule | 1 |
| 10 | EN/KR manual + screenshots | User-visible feature docs per `docs/AUTHORING.md` — covers Send-to-aimer flow change, analysis result page, redaction range admin, retention settings | 5, 7, 8 |
| 11 | aice-web-next caller integration (separate repo) | Filed in `aicers/aice-web-next`: replace stub events_data with real single-event payload, rename `Send to aimer` button, and rewire it from XHR to a hidden multipart `<form>` (`method="POST"`, `enctype="multipart/form-data"`, `target="_blank"`, `action="/api/analysis/analyze-bridge"`) carrying `context_token`, `events_envelope`, `events_data`, and `analyze_params_token`. `form.submit()` opens the result page in a new tab via top-level navigation; the original aice-web-next tab is preserved | wrapping endpoint sub-issue (aimer-web#274 — endpoint + `analyze_params_token` + PAR + `/continue`); `/api/analysis/analyze` (this row 8) remains the same-origin caller's entry and is unchanged |

Aimer-side cleanup (aimer#388) is independent: it lands after this design's runtime is deployed and confirmed to be the only `analyzeEvent` caller (see "aimer-side coordination" above).

## Cross-cutting expectations

The implementation sub-issues collectively complete the feature; each is responsible for the testing and documentation appropriate to its scope. The following apply to the feature as a whole, not to a single sub-issue:

- **EN/KR manual pages with screenshots** for every user-visible surface (Send-to-aimer flow change, analysis result page, redaction range admin, retention settings) per `docs/AUTHORING.md`. Tracked as sub-issue 10 above.
- **Redaction engine unit tests** covering at minimum: IPv4 / IPv6 private always-redact; public-IP customer-range match (matched ↔ redacted, unmatched ↔ pass-through); email and MAC regex matching; duplicate-entity collapse within one event (10 mentions of same IP → 1 map entry + 10 occurrences of same token); nested JSON traversal (tokens substituted at any depth, structural keys preserved); LLM response hallucination scan substitution.
- **DB tests** covering: new permission grant assignments compile against existing role seed (no missing permission); upsert / force behaviour on `event_analysis_result` PK (same model overwrites, different model creates new row); map cascade rule (map deleted only when both ingestion-side and analysis-side referents are gone); retention clock origin per table.
- **Contract test for `analyzeEvent`** TypedDocumentNode: parses against the vendored aimer SDL, types align with `AnalysisResult { severityScore, likelihoodScore, analysis }`. Required because the GraphQL client (#230) rejects raw query strings at runtime.


