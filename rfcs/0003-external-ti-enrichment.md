# RFC 0003: External threat intelligence enrichment

- Status: **Draft** (pre-review; to be refined before scoping implementation issues)
- Authors: @sehkone
- Tracks (consumers): [#361](https://github.com/aicers/aimer-web/issues/361) (deterministic `known_ioc_hit` floor source), [#318](https://github.com/aicers/aimer-web/discussions/318) C1 (external TI enrichment in LLM input)
- Depends on: RFC 0001 (analysis storage, redaction), RFC 0002 (periodic LLM analysis, floor policy)
- Related: [#292](https://github.com/aicers/aimer-web/issues/292) (RFC 0002 umbrella, floor policy), [#330](https://github.com/aicers/aimer-web/issues/330) / PR [#339](https://github.com/aicers/aimer-web/pull/339) (floor consumer wiring), [#342](https://github.com/aicers/aimer-web/issues/342) (story analysis manual)

## Summary

External threat-intelligence (TI) is useful at **many points** across aimer-web, not just the two features that first surfaced the need. This RFC establishes **one enrichment layer** and enumerates **every place that layer is consumed**, so TI usage is designed as a whole rather than bolted on per feature.

The two consumers that motivated the work:

1. **#361** — produce a deterministic, binary `known_ioc_hit` signal that floors a story's effective likelihood to `0.95` at matrix-lookup time. This is a *non-LLM* high-confidence override and must be reproducible and auditable.
2. **#318 C1** — enrich the LLM input with external context (reputation, first-seen, registration age, feed membership) so the model's reasoning over events improves.

But the same enrichment, once computed, also serves **selective retention/ingest, triage/priority tiering, periodic reports, event-level analysis, and (future) interactive lookup**. The full set is enumerated in §"TI consumer map". The governing principle is **enrich once, many consumers** (§"Enrich once, many consumers"): a single enrichment layer produces one cached, audited result per indicator, and every downstream stage *reads* it — no stage re-queries TI on its own.

This RFC proposes a **pluggable set of TI source adapters** feeding that layer, organized into two tiers by data-egress class, rolled out in phases. The key design hinge is that each enricher declares whether its hit is a **deterministic IOC hit** (curated known-bad → may feed the binary floor) or a **soft reputation signal** (→ narrative / ranking only, never the floor).

The enrichment layer itself lives **inside aimer-web**. TI is deliberately **not** performed in aice-web-next (air-gapped; see §"TI consumer map"). The only component that may run as a **separate self-operated server** is MISP (and, much later and optionally, OpenCTI) — and even MISP is not mandatory for the baseline feature.

## Motivation

- The LLM today sees only redacted events + story metadata + baseline statistics. A C2 callback to a known-bad domain reads as a generic outbound connection. With enrichment ("this domain is on 47 TI feeds, registered 3 days ago, no Alexa rank") the same event lifts from MEDIUM to CRITICAL with high likelihood. This is the signal-quality ceiling described in #318 C1.
- The `known_ioc_hit` floor wiring already landed (#330 / PR #339), but the column defaults `false` and nothing produces a `true`. #361 establishes that determining "did this story touch a *known* indicator of compromise" requires **external information**, that aice-web-next is air-gapped and cannot reach external services, and that aimer-web already calls the LLM and can reach external services — so the determination belongs in aimer-web.
- Both features need the same primitive: take indicators observed in a story's members (IP / domain / DNS query / URI / file hash, etc.) and look them up against external TI. The difference is only in what the lookup result is used for.

## Non-goals

- Replacing or modifying RFC 0002's floor policy. Stored `likelihood_score` stays raw; floors apply only at matrix-lookup time, per #292. This RFC only *produces the input* to `applyLikelihoodFloors`.
- A full threat-actor knowledge graph / attribution capability (#318 B1). That is a separate future effort; see "OpenCTI" below for why it is out of scope here.
- The feedback/learning loop (#318 C2), detection-rule tuning (#318 C3), and other #318 items.
- **TI evaluation inside aice-web-next** (stage ⓪) — excluded by the air-gap premise; the sender carries raw indicators only.

Note on what is **deferred but in-scope** (vs. a non-goal): event-level enrichment (④), periodic-report TI aggregation (⑤), selective-retention signal (①), interactive lookup (⑥), and the severity-axis question are all consumers of *this* layer, scheduled after the core consumers. They are enumerated in §"TI consumer map" precisely so they are not mistaken for omissions.

---

## Conceptual model

### Two output types

Regardless of which stage consumes it, every enrichment result is exactly one of two output types — this is the hinge the whole design turns on:

| Output type | Question it answers | Shape | May drive the floor? |
| --- | --- | --- | --- |
| **`deterministic_ioc`** | "is this indicator on a curated known-bad list?" | **binary** match with provenance | **yes** (if `floorEligible`) |
| **`soft_reputation`** | "what is this indicator's reputation / context?" | **structured facts / scores** | **never** |

`#361` is the first consumer of the `deterministic_ioc` type; `#318 C1` is the first consumer of the `soft_reputation` type (plus deterministic facts as narrative). Everything below reuses these same two types.

### TI consumer map (full scope)

TI is consumed at **every stage where aimer-web makes a decision about an event/story**. This map is the RFC's claim to completeness: it enumerates each stage, whether TI applies there, and on what terms. Stages marked *deferred* are in-scope architecturally (same layer, same output types) but implemented after the core consumers.

| # | Stage (where) | TI used? | What it does | Sync/async | Touches the floor? | Phase |
| --- | --- | --- | --- | --- | --- | --- |
| ⓪ | **aice-web-next, before send** | **No — excluded** | air-gapped, cannot reach external services (#361's founding premise); sender's only TI-related duty is to *carry raw external indicators* in the payload, not to evaluate them | — | — | n/a |
| ① | **aimer-web ingest / selective retention** | Yes | known-IOC hits raise retention priority and exempt a story from noise sampling-out — applied as an **async priority signal after raw ingest, before the retention sweep / readiness-dirty processing acts on it**; raw ingest itself is never blocked on enrichment | **async** (post-ingest, pre-sweep; must not gate raw ingest) | no — retention/priority only | later |
| ② | **aimer-web triage / priority tiering** | Yes | `known_ioc_hit` → likelihood floor (**#361**); `soft_reputation` → intra-tier ranking / highlight / grouping (never the floor) | sync at analysis time | **yes** (deterministic only) | P1a + later |
| ③ | **aimer-web story LLM analysis** | Yes | inject facts into the `analyzeStory` prompt (**#318 C1**) | sync at analysis time | no | P1b+ |
| ④ | **aimer-web event-level LLM analysis** (`analyzeEvent`, RFC 0001) | Partly (verdict scoped #492; facts + analyze deferred) | the per-event IOC **verdict + readiness** for a loose `(source_aice_id, event_key)` baseline event — the tier-A prerequisite (**#492**) — reusing the story IOC-matching machinery against the stored redacted `baseline_event.raw_event`, with the **v1 per-event floor defined identical to the story #361 floor** (kept a distinct policy surface so it can tighten later without touching the story floor). Same fact-injection scoped to one `(aice_id, event_key)`, and the per-event analyze path, remain **deferred** | verdict async post-ingest; fact-inject sync at analyze time | yes (deterministic; own policy, v1 = story mirror) | verdict P1a-event (#492); facts/analyze deferred |
| ⑤ | **aimer-web periodic reports** (LIVE/DAILY/WEEKLY/MONTHLY) | Yes | aggregate TI signal into reports — "N known-IOC matches this week", newly-observed C2 infrastructure, feed-membership trend, top malicious ASNs — **reusing stored evidence records, no new TI calls** | async (report generation) | no | later |
| ⑥ | **aimer-web interactive / on-demand lookup** (follow-up Q&A, analyst manual check; #318 F1) | Yes (deferred) | operator asks "is this indicator malicious now?" at query time | sync on demand | no | deferred |

**Consumer ④ scoping (#492).** ④ is split: its **verdict + readiness** prerequisite is now scoped and built, while fact-injection and the per-event LLM analyze path stay deferred. The built piece (`runEventEnrichment`) evaluates an individual `baseline_event` *not* belonging to any story (membership decided by the `story ⋈ story_member` join on `(story.source_aice_id, member_event_key)`), reading indicators from the stored, already-redacted `baseline_event.raw_event` — deduped to the latest row by `received_at` (then `baseline_version DESC`) since `event_key` recurs across baseline versions — and reusing the story IOC-matching machinery (`extractIndicators`, the Tier-1 dispatcher, `matchSatisfiesFloor`, `buildEvidenceRecord`, coverage aggregation). The **v1 per-event floor is defined to be identical to the story #361 floor** (a match qualifies iff `matchSatisfiesFloor`); it is kept a distinct policy surface so it can be tightened later (e.g. a source subset) without touching the story floor. The result is persisted at `(source_aice_id, event_key)` grain: a monotonic `known_ioc_hit` verdict + `coverage_status` (so `false-complete` is distinguishable from a source-down `false-unknown`) in `event_enrichment_state`, with **floor-supporting matches only** in `event_ioc_evidence` (mirroring `story_ioc_evidence`; soft-reputation / floor-ineligible matches never enter evidence and never qualify tier A). Readiness and verdict live in the same row, read together so the downstream worker cannot gate on a torn read. **This is the prerequisite, not the completion of ④** — event-level narrative facts (the `story_enrichment_fact` analog) and the `analyzeEvent` path remain deferred, as does the orchestration (ingest-hook seeding, worker tick, bulk loose-event scan) that *selects* loose events and drives this primitive at scale (RFC 0002 #489's downstream auto-analysis worker).

Two cross-cutting notes:

- **Severity axis.** TI today feeds only the *likelihood* floor. Some TI ("this hash is a known ransomware family") arguably bears on *severity* too. Whether TI may inform `severity_score` is **deferred** — recorded here so it is a conscious omission, not an oversight. Until decided, TI affects likelihood only.
- **aice-web-next's role (⓪).** Excluded as a TI *evaluator*, but it remains the *source of raw indicators*. The #361 precondition (members must carry un-redacted external indicators) is exactly what stage ⓪ owes the pipeline; if indicators are missing, the fix is a scoped sender change to *include* them, never to *evaluate* them.

### The type-distinction hinge (most important design decision)

Each enricher must classify every hit as exactly one of:

- **`deterministic_ioc`** — membership in a curated known-bad list (high precision). May feed `known_ioc_hit` **and** the C1 narrative.
- **`soft_reputation`** — a score / signal that is suggestive but not authoritative (e.g., AbuseIPDB 40%, a reputation score). Feeds the C1 narrative **only**; must **never** drive the binary floor.

Rationale: the floor performs a strong action (can cross a 2-tier boundary, MEDIUM → CRITICAL). Letting soft scores drive it reintroduces the false-positive and circularity problems that the deterministic floor exists to avoid. Keeping the type on the enricher output makes the split automatic as new sources are added.

### Why not the LLM itself as the IOC source

For #361 specifically, LLM judgment was considered and rejected (see #361 option (b)):

- **Freshness** — knowledge cutoff means a domain registered 3 days ago is invisible; that is exactly the high-value case.
- **Reproducibility / auditability** — non-deterministic output, no citation for "why IOC".
- **Hallucination** — confidently wrong either way; floor misfires erode trust.
- **Circularity** — the LLM flooring its own likelihood estimate defeats the floor's reason to exist (a deterministic external override).

The LLM still has legitimate roles in the broader pipeline, but never as the authority for the binary floor:

1. **Indicator extraction / normalization** of messy event fields and TI outputs into compact prompt facts.
2. **Tool-using enricher** (web search / TI MCP) where the *authority is the tool/feed*, the LLM only orchestrates. This is a Tier 2 adapter.
3. **Last-resort fallback** for entities no feed covers — output tagged `confidence: low, source: llm_websearch`, with citations, **always `soft_reputation` type**, never feeding `known_ioc_hit`.

---

## Architecture

### Enrich once, many consumers

The TI consumer map lists many stages, but there is exactly **one producer**: the enrichment layer. Each indicator is enriched **once per cache key** (see §"Caching"), the result is cached and written to an evidence record, and consumers *read* that stored result. **No consumer calls a TI source directly.**

This includes interactive lookup (⑥): an on-demand query still goes **through the enrichment layer** — it may trigger a *live* enrich on a cache miss / expired TTL, but it obeys the same cache, source policy, and egress audit as every other path. "Enrich once" is therefore not "never enrich again" — it is "all enrichment flows through the one layer, deduplicated by cache key." A fresh enrich happens only on miss/expiry, never per-consumer for the same key.

This is not just tidiness — it is correctness and cost control:

- **Consistency** — triage, the LLM prompt, the periodic report, and the audit log all see the *same* match set and `coverageStatus` for a given indicator. Re-querying per stage would let them disagree.
- **Cost / rate limits** — Tier 2 sources are paid and rate-limited (customer-supplied keys). Querying once per indicator instead of once per stage is the difference between viable and not.
- **Egress minimization** — each off-host lookup is a privacy event (logged per §"Secrets and per-customer egress"). Fewer lookups, less exposure.

```
        observed indicators (from story / event members)
                          │
                  ┌───────▼─────────┐
                  │ enrichment layer │  enrich once → cache + evidence record
                  └───────┬─────────┘   (matches[], facts[], coverageStatus, audit)
        ┌─────────────────┼───────────────┬───────────────┬──────────────┐
        ▼                 ▼               ▼               ▼              ▼
  ① retention/      ② triage /      ③ story LLM     ⑤ periodic     ④/⑥ event-level
    ingest          priority tier    analysis (C1)    reports         / interactive
   (async, no       (#361 floor +   (fact inject)    (reuse stored   (deferred)
    gate)            soft ranking)                    evidence)
```

Consumers differ only in **which fields they read** and **when**: the floor reads `deterministic_ioc && floorEligible`; the LLM reads `facts[]`; reports read aggregates over stored evidence; retention reads hit/coverage. Adding a new consumer is a read against the existing layer, not a new integration.

### Pluggable enricher interface (lives in aimer-web)

The real abstraction is the enricher interface, **not** any particular product. Every source — local feed, online API, MISP, future OpenCTI — enters as an adapter implementing the same interface.

```ts
type HitType = "deterministic_ioc" | "soft_reputation";

// One indicator can produce MANY matches across sources/feeds/classifications
// (e.g. MISP + VT + abuse.ch all hit the same domain). Do not collapse to a
// single hit/hitType.
interface EnrichmentMatch {
  source: string;              // provenance / citation (e.g. "abuse.ch/feodo")
  sourcePolicyId: string;      // which source-policy entry governs this source
  hitType: HitType;            // deterministic_ioc | soft_reputation (intrinsic to the match)
  floorEligible: boolean;      // does the active source policy allow THIS match to drive the floor
  classification?: string;     // source-native label (e.g. "c2", "malware", "scanner")
  confidence?: number;
  sourceVersion?: string;      // feed version / pulse id / engine set
  feedHash?: string;           // content hash of the matched feed snapshot (audit)
}

interface EnrichmentResult {
  indicator: NormalizedIndicator;  // post-normalization value actually matched
  matches: EnrichmentMatch[];      // [] when no source hit
  facts: EnrichmentFact[];         // redaction-token-aware narrative facts for C1
  errors: EnricherError[];         // per-source failures (timeout, auth, rate-limit)
  checkedAt: string;               // when enrichment ran (audit / reproducibility)
  expiresAt?: string;              // cache TTL boundary
}

interface Enricher {
  supports(entityType: EntityType): boolean;   // IP | DOMAIN | URL | HASH | CVE ...
  enrich(indicator: NormalizedIndicator): Promise<EnrichmentResult>;
}
```

`known_ioc_hit` is then derived as: *any `EnrichmentMatch` across the story's members with `hitType === "deterministic_ioc" && floorEligible === true`*. Both conditions are explicit on the match (`hitType` is intrinsic to the match; `floorEligible` is set from the active source policy `sourcePolicyId`), so "floor-eligible source" is a stored property, not an implicit rule.

`known_ioc_hit` stays a plain `boolean` (the floor reads only this). But a boolean cannot distinguish "false because nothing matched (complete coverage)" from "false because a deterministic source was stale / unavailable". That distinction is carried by a separate **coverage status** (see "Audit / evidence model"), not by overloading the boolean: the floor uses the boolean; UI, audit, and operational alerting read the status.

The worker (execution order is normative — getting it wrong either starves matching or leaks sensitive indicators):

1. **Obtain indicators from the stored, already-redacted member rows — not a raw pre-redaction payload.** Per RFC 0001, raw canonical content never touches disk; redaction happens at ingest, before the row is committed. Enrichment runs **asynchronously after ingest**, so the raw payload is gone. The worker therefore draws indicators from two sources that *do* persist: (a) **external / pass-through indicators**, which RFC 0001 stores **raw** in the redacted text (attacker IPs outside any range, domains matching no owned-domain — exactly the usual enrichment targets), read directly; and (b) **customer-asset indicators**, which are stored as tokens — the worker decrypts the event's redaction map to recover the value for matching. Both are normalized (see "Indicator normalization"). The worker keeps the mapping `normalized indicator ↔ redaction token` (identity, for raw indicators) for use in steps 3–4. The enrichment result it stores is **story-agnostic** (redacted fact text + self-scoped fact map only); it records **no** `(aice_id, event_key)` link. At prompt-build a customer-asset fact token is simply renamed to this story's fact scope `F{k}` (RFC 0001 Amendment A.1 step 2) — there is no fact↔member token reconciliation, so the stored result needs no story- or member-specific data. (If a future indicator class were neither stored raw nor tokenized, ingestion would need to persist a normalized enrichment-input projection at write time; in v1's policy every indicator class is one or the other, so reading the redacted row + map is sufficient.)
2. **Match against enrichers**, dispatching each normalized indicator to enrichers that `support()` its entity type. Tier 1 matches the **normalized indicator locally** (never leaves the host). Tier 2 may send it off-host **only when the per-customer egress opt-in for that source is enabled**; every such egress is recorded in the per-customer egress audit log.
3. **Derive `known_ioc_hit`** = OR over the story's members of any `EnrichmentMatch` with `hitType === "deterministic_ioc" && floorEligible === true`. Persist the supporting audit record (see "Audit / evidence model").
4. **Redact the fact at write, then inject the stored (redacted) fact** — the fact is redacted under the same policy as event payloads **when the enrichment result is written to disk** (RFC 0001 Amendment A, "redact at the DB-write boundary"), not at injection time. Per that policy, **customer-asset** indicators are stored as tokens (raw value only in the fact's encrypted map), while **external / pass-through** indicators (the usual enrichment target — attacker IPs outside any registered range, domains not matching a registered owned-domain) are stored **raw**, identically to how they already appear raw in the redacted member text. Prompt assembly then *reads* the stored fact and only renames tokens to story scope (`E{i}`/`F{k}`) — it does not re-redact. The raw indicator and its match are used internally (steps 2–3) before the write.
5. **Feed `known_ioc_hit`** into the existing `applyLikelihoodFloors`.

In short: **raw indicators are used internally for local matching and (opt-in) Tier 2 lookup; at the DB-write boundary the fact is redacted under RFC 0001 Amendment A's policy — customer-asset values become tokens (raw only in the encrypted map), external indicators stay raw (consistent with the post-#422 payload policy). Every later stage, including LLM injection, reads the already-redacted fact. Any non-opted-in external service still never receives raw customer-asset values.**

> Note: RFC 0001 Amendment A ([#424](https://github.com/aicers/aimer-web/issues/424)) is authoritative for fact redaction and **supersedes any earlier wording here implying the LLM "never sees raw indicators"** — external indicators are intentionally raw on both the payload and fact paths; only customer-asset indicators are tokenized.

Cross-cutting concerns owned by the layer (all in aimer-web): per-entity-type dispatch, **per-customer enable flags**, **redaction-token-aware fact injection**, result caching per indicator, and per-enricher rate / cost limiting.

```
aimer-web → [enricher interface]
              ├─ direct-abuse.ch adapter   (lightweight default, no extra server)
              ├─ GreyNoise / AbuseIPDB / Shodan / VirusTotal adapters
              ├─ MISP adapter              (when a customer runs MISP)
              └─ (future) OpenCTI adapter
```

### Dependencies inherited from #318 C1

- **Redaction-token-aware enrichment fact injection.** RFC 0001 redaction is event-payload-only; extending it so enrichment facts reference redaction tokens is a small sub-effort of its own. Confirm that customer-own public IP ranges are redacted while *external* malicious IPs / domains survive (otherwise matching is starved).
- **Per-customer opt-in policy.** Some customers cannot send queries to public TI services. This is the same axis as the Tier split below.

### Precondition to confirm (from #361)

The story-payload members delivered from aice-web-next must actually carry the external indicators needed for matching, un-stripped by redaction. If insufficient, define what aice-web-next must additionally include — a far smaller sender change than the original producer scope (aicers/aice-web-next#650).

### Indicator normalization

Matching is only as good as normalization. A normalized indicator is the value actually matched against feeds. How indicators are stored is a separate concern — see "Audit / evidence model" below. Rules to define (v1):

- **URL** — canonicalization (scheme/host casing, default ports, path/query normalization, percent-encoding); decide whether to match URL, host, and registered domain separately.
- **Domain** — lowercase, trailing-dot strip, **punycode / IDN** normalization (match both U-label and A-label).
- **IP** — IPv4/IPv6 canonical form; **CIDR** membership matching; **private/reserved vs public** classification (private/reserved never sent to Tier 2 and never floor-eligible).
- **Hash** — distinguish hash type (MD5 / SHA-1 / SHA-256); normalize casing.
- Track the normalization version so the **matching / cache / dedupe** key stays interpretable as rules evolve (it scopes the enrichment cache key — see "Caching, freshness, and feed-refresh policy" — and the in-run dedupe key). It is **not** persisted on the evidence record: indicator storage there is redaction-consistent (raw external / customer-asset token), with no HMAC to keep interpretable.

### Audit / evidence model

`reproducible / auditable` (Summary) requires storing *why* a result was produced, not just the boolean. A `known_ioc_hit = true` must be explainable after the fact, so persist an evidence record alongside the story result.

**Indicator storage is redaction-consistent.** The evidence record stores the indicator exactly the way the rest of the system already does — there is no separate HMAC scheme. The **`redactionToken`** carries the indicator: the **raw value for an external indicator** and a **`<<REDACTED_*_NNN>>` token for a customer-asset indicator** (whose original lives only in the existing encrypted redaction map). Each record stores:

- the **`redactionToken`** (raw external indicator, or the customer-asset token whose original is in the redaction map),
- the **event redaction-map scope** (`sourceAiceId` + `memberEventKey`, i.e. the `(aice_id, event_key)` key) the indicator was extracted under — what recovers a customer-asset token, and provenance for a raw external one,
- which **source** (`sourcePolicyId`) and **source/feed version** (`sourceVersion` / `feedHash`),
- the resulting **`hitType`** and **`floorEligible`**,
- the **match timestamp** (`checkedAt`) and cache `expiresAt`.

**Reproducibility.** An external indicator is **self-sufficient** — the raw value in `redactionToken` can be re-checked against a feed snapshot directly. A customer-asset indicator is recoverable via the **existing redaction map**: the stored `(sourceAiceId, memberEventKey)` scope identifies the exact `event_redaction_map` row, and decrypting it demaps the token back to the original. The scope is required because token numbering restarts per event — the same `<<REDACTED_*_NNN>>` from two members maps to different values, so the token alone is ambiguous (this is the same dependency every other consumer already has). This is the same trade-off the redaction layer makes everywhere; evidence does not add a second mechanism.

**Coverage status (resolves the `unknown` ↔ boolean gap).** Persist, per story result, alongside the boolean:

- `known_ioc_hit: boolean` — what the floor reads (and only the floor).
- `ioc_enrichment_status: complete | partial | unknown | stale` (an evidence-level `coverageStatus`) — `complete` = all relevant deterministic sources answered; `partial` = some answered; `unknown` / `stale` = a deterministic source was unavailable or past its max age. UI, audit, and operational alerting read this status; **the floor ignores it**.

`partial` floor semantics: **answered sources may still set `known_ioc_hit = true`** if one produced a floor-eligible deterministic hit. An unavailable source only downgrades the coverage status — it never flips the boolean by itself, and it never suppresses a hit that an answered source already produced. In other words, the boolean is monotonic in observed hits; missing coverage is reported via status, not by hiding a hit.

This makes "false but complete" and "false because a source was down" distinguishable in storage. Storing only the boolean makes later explanation impossible; the evidence record + coverage status are part of this RFC's scope, not an afterthought.

### Caching, freshness, and feed-refresh policy

- **Cache / evidence key is customer- and source-policy-scoped**, not bare indicator. The same indicator can yield different results and different usability across customers, because per-customer opt-in, customer-supplied keys, the matched source, `sourcePolicyId`, and floor eligibility all vary. Key on **`customerId + normalizedIndicator + sourcePolicyId (source) + normalizationVersion`**, with `expiresAt` TTL. ("Enrich once" therefore means once *per this key*, not once globally per indicator.)
- **Feed-refresh failure / stale-feed policy**: define max feed age; when a Tier 1 feed is stale or its refresh fails, the per-source `errors` set the result's **`coverageStatus` to `unknown`/`stale` (not a silent `false`)**, so a stale feed never silently suppresses a floor (see "Audit / evidence model").
- Refresh cadence per feed is scheduled by a background worker (ties to RFC 0002 worker model).

### Secrets and per-customer egress

- **API-key lifecycle** for customer-supplied Tier 2 keys: storage (OpenBao Transit), rotation, and deletion/revocation. Keys are per-customer and never logged.
- **Per-customer egress audit log**: every Tier 2 lookup that sends a customer indicator off-host is recorded (source, indicator-as-token, timestamp, customer), so a customer can audit exactly what left their boundary.

---

## Source taxonomy: two tiers by egress

**Egress tier and floor eligibility are two independent axes. Do not conflate them.**

- **Egress tier** (below) classifies a source by *where the customer's indicator goes* — it governs the per-customer opt-in policy only.
- **Floor eligibility** (`hitType`, see "the type-distinction hinge") classifies a *match* by *whether it may drive the binary floor* — it governs `known_ioc_hit`.

These do not imply each other. A Tier 1 local feed can be noisy and therefore `soft_reputation` (not floor-eligible); a customer-owned MISP/TAXII source can be online (Tier 2, egress) yet produce a `deterministic_ioc` match that *is* floor-eligible. Egress tier never decides floor eligibility, and vice versa.

The egress split maps directly to the per-customer opt-in policy:

| Tier | Definition | Egress | Default |
| --- | --- | --- | --- |
| **Tier 1** | local / imported feeds, matched locally | **none** (only feed download leaves) | on by default, no opt-in friction |
| **Tier 2** | online query APIs | **per query** (customer indicator leaves) | opt-in per customer |

Important: "use a feed" ≠ "query a remote service". Tier 1 works by **importing feed files into local storage and matching locally** — the only thing that leaves is the feed download, never the customer's observed indicators. Whether a given Tier-1 or Tier-2 match feeds `known_ioc_hit` is decided solely by its `hitType`.

---

## Source catalog with free / commercial breakdown

Two separate axes: **(a) is there a free tier**, and **(b) is commercial-product use permitted** (free-to-use ≠ free-to-embed-in-a-commercial-product — this is the real trap for a commercial managed-service product).

### Tier 1 — local / imported feeds

> The "commercial-product use" column below is **provisional and must be confirmed against each vendor's current terms before integration** (see Open question 9). Several sources that are free for evaluation / non-commercial use are *not* automatically free for use inside a commercial managed-service product. Sources are cited at the end of the catalog.

| Source | Cost | Commercial-product use | Note |
| --- | --- | --- | --- |
| abuse.ch (URLhaus / ThreatFox / Feodo / MalwareBazaar) | Free tier | ⚠️ **conditional** — for-profit / commercial use may require a paid commercial API or license; verify per feed | Free auth-key (account) required; **feed redistribution restricted** → do not bundle, instance fetches directly |
| Spamhaus DROP / EDROP | Free | ⚠️ verify — DROP/EDROP published publicly, but confirm commercial-use terms | **Full reputation (ZEN / DQS) is commercial** |
| CISA KEV | Free | Public domain (US gov) | — |
| NVD (CVE) | Free | Public domain (US gov) | NIST; free API key, rate-limited |
| MITRE ATT&CK | Free | Permissive (already vendored) | — |

→ Tier 1 can likely close #361 at **little or no licensing cost**, but this is **conditional on confirming each feed's commercial-use terms** (notably abuse.ch for for-profit use) — not an unconditional "zero cost".

### Tier 2 — online reputation APIs (mixed)

| Source | Cost | Commercial-product use | Note |
| --- | --- | --- | --- |
| Shodan InternetDB | Free | ⚠️ verify | No key; basic host/ports/CVE. **Full Shodan API is commercial** |
| AbuseIPDB | Freemium | ⚠️ **free/individual tier is for non-commercial / personal / evaluation use** per their terms | Free ~1,000 checks/day (registered); commercial use needs a paid plan |
| GreyNoise | Freemium | ⚠️ **community/free tier is explicitly non-commercial** per their terms | Commercial / production use needs a paid plan |
| VirusTotal | Freemium | ⚠️ **public/free API forbidden in commercial products** | Commercial embedding requires VT Enterprise (paid). Biggest trap |

→ Tier 2 is mixed and **none of the free tiers can be assumed usable inside our commercial product**. VirusTotal forbids it outright; AbuseIPDB and GreyNoise restrict their free tiers to non-commercial/evaluation use. This is exactly why these sources are integrated via the **customer-supplied key** model (below) — the customer's own (possibly paid) entitlement is what authorizes production use.

### Recommended licensing pattern

Paid / license-sensitive sources (VirusTotal, GreyNoise, AbuseIPDB high-volume) are integrated via a **customer-supplied API key** model. Cost and ToS burden shift to the customer, and this aligns with "selectable per environment".

> All licensing / ToS terms above must be re-verified at implementation time; vendor terms change. Sources consulted: [VirusTotal API overview](https://docs.virustotal.com/docs/api-overview), [AbuseIPDB legal](https://www.abuseipdb.com/legal.html), [GreyNoise terms](https://www.greynoise.io/terms), [ThreatFox / abuse.ch Community API](https://threatfox.abuse.ch/api/).

---

## Platforms (separate servers)

| | Cost | Commercial use | Deployment |
| --- | --- | --- | --- |
| **MISP** | Free (OSS, GPL/AGPL) | Allowed | **Separate self-operated server** (PHP app + DB + Redis + workers; misp-modules for online enrichment). Cannot be embedded in aimer-web |
| **OpenCTI** | Community free (Apache 2.0) | Allowed | Separate server, heavier than MISP. **Enterprise Edition / Filigran managed cloud (SaaS) is paid** |

### MISP

- **Canonical, single project** (CIRCL) — the de-facto standard for IOC sharing/matching. Best fit for #361 (deterministic matching) and as a local aggregation hub fitting the on-prem posture (OpenBao / Keycloak / mTLS).
- Can **subsume Phase 1–4** for a customer who runs it: MISP `feeds` ingest abuse.ch/CISA/Spamhaus etc. (Tier 1), and `misp-modules` can proxy VT/GreyNoise/AbuseIPDB/Shodan (Tier 2). But proxying online APIs through MISP does **not** remove egress / opt-in / licensing / latency constraints, and online enrichment via misp-modules is less flexible than direct adapters.
- **Do not make MISP a hard dependency for the baseline floor.** Keep a lightweight direct-feed path (abuse.ch → aimer-web DB → local match) so #361 has a zero-extra-server default. MISP is the optional power-user / customer-CTI upgrade, expressed as one adapter.

### OpenCTI (out of scope, future)

- Knowledge-graph oriented (indicator ↔ malware ↔ threat actor ↔ TTP), STIX2-native. Its distinctive value (actor attribution, relationship/trend analysis) maps to **#318 B1 / E1 / E3**, not to #361 or C1.
- If adopted later, the standard pattern is **MISP (IOC store) → OpenCTI (knowledge layer)**, fed via the MISP↔OpenCTI connector — a downstream layer, not a parallel system queried separately. Adopting it is a non-breaking adapter addition thanks to the enricher interface.

### SaaS considerations

- OpenCTI has an official managed cloud (Filigran); MISP has no first-party SaaS (only third-party hosting / self-deploy on cloud VMs).
- A remote/SaaS TIP means **sending the customer's observed indicators to a third-party cloud** → it collapses a Tier 1 (local, deterministic, on-by-default) component into a Tier 2 (egress, opt-in) one, and adds availability/latency dependency to the analysis hot path plus multi-tenant data-mixing concerns.
- Therefore: **#361 + sovereignty-sensitive customers → no SaaS; local feeds / local MISP only.** SaaS is acceptable as a **Tier 2, opt-in** option for C1 enrichment for customers who have already accepted external queries. Keep SaaS as a selectable adapter, never the default / forced path.

### Deployment footprint summary

| Component | Phase / Tier | Footprint |
| --- | --- | --- |
| enricher interface / matching / injection / per-customer flags | all | inside aimer-web (no new server) |
| abuse.ch & other Tier 1 feeds | P1 / T1 | imported into aimer-web DB (periodic fetch worker) — no server |
| GreyNoise / AbuseIPDB / Shodan / VirusTotal | P2–3 / T2 | external SaaS APIs (not our infra) |
| MISP | P4 (optional) / T1·T2 | separate self-operated server |
| OpenCTI | later (optional) | separate self-operated server |

**Only MISP (and later optionally OpenCTI) is a separate self-operated server, and even MISP is not always required** (Phase 1 can run with in-aimer-web matching).

---

## Phasing

**Implementation scope decision:** this RFC *builds* only the **core consumers** — ② triage floor (#361) and ③ story LLM analysis (C1) — plus the enrichment layer they require. The other consumers in the TI consumer map (① selective retention, ④ event-level, ⑤ periodic-report aggregation, ⑥ interactive lookup) and the severity-axis question are **enumerated here for completeness but deferred**; each becomes its own follow-up once the core lands. The map exists so these are recognized as planned reads against the same layer, not forgotten scope.

Phase = build order; Tier = egress class. They are orthogonal axes that happen to align, because the zero-egress / no-opt-in-friction / deterministic Tier 1 is the natural thing to ship first.

Phase 1 is split so #361 can close without waiting on the LLM-injection work:

| Phase | Sources / work | Tier | Covers |
| --- | --- | --- | --- |
| **Phase 1a** | enricher interface + per-entity dispatch + **deterministic local IOC-feed matching** (abuse.ch / Spamhaus-style IOC feeds: IP / domain / URL / hash) + **audit/evidence record** + coverage status + `known_ioc_hit` wiring into `applyLikelihoodFloors` + minimal per-customer flags | Tier 1 only | **#361 closed** |
| **Phase 1b** | **redaction-token-aware enrichment fact injection** into LLM input (RFC 0001 extension), feeding Tier 1 facts to C1 | Tier 1 only | **C1 bootstrap** |
| **Phase 2** | GreyNoise / AbuseIPDB / Shodan (IP), opt-in + per-customer key + egress audit | Tier 2 only | C1 (IP — most common entity) |
| **Phase 3** | VirusTotal (domain / URL / hash), opt-in + key + rate/cost | Tier 2 only | C1 (domain / URL / hash) |
| **Phase 4** | MISP / STIX-TAXII adapter (local or, opt-in, SaaS) | Tier 1 or 2 | #361 source extension + C1 (customer-own CTI) |

> **Note — KEV / NVD / MITRE are not P1a IOC feeds.** They are **vulnerability / TTP intelligence, not IOC feeds** — they match CVE indicators, which only help the deterministic floor if story members actually carry CVE identifiers. They are therefore **not** part of the P1a deterministic-floor scope; pull them in only where CVE indicators are present, as **C1 enrichment** or a future vulnerability-enrichment effort.

Splitting P1a/P1b lets the deterministic floor (#361) ship and be verified end-to-end on its own, before the redaction-token-aware injection sub-effort (the larger, RFC-0001-touching piece) lands. P1a does **not** require any LLM-side change.

Coverage characterization:

- **#361 is effectively complete at Phase 1a** (deterministic local matching + audit record satisfies the floor and the issue's acceptance checklist). Phase 4 does not reopen #361; it only **adds sources** to the same binary floor with no code change (pluggable).
- **#318 C1 starts at Phase 1b and matures across 2 → 3 → 4.** Its two named dependencies (redaction-token-aware injection, per-customer opt-in) are the infrastructure laid in Phase 1b + Phase 2; later phases fill in the richness ("47 feeds, registered 3 days ago"). C1 is a cumulative-coverage item, not a binary one.
- **The enricher layer is the shared touchpoint**: the same abuse.ch match splits into the binary `known_ioc_hit` (#361, `deterministic_ioc`, P1a) and a narrative fact (C1, P1b). Wiring the per-match `hitType` declaration in P1a makes every later source split correctly and automatically.

Phase → Tier alignment: P1a/P1b = pure Tier 1; P2–3 = pure Tier 2; P4 = Tier 1 or 2 depending on deployment. No single phase mixes tiers within itself; the *set* {P1,P2,P3} spans both tiers.

### Two phasing axes: sources vs. consumers

The phases above sequence **sources** (which feeds/APIs come online). The TI consumer map sequences **consumers** (which stages read the layer). They are independent: a consumer can be added without new sources, and vice versa. The source phases (P1–P4) ship the layer and its first two consumers (triage floor ②, story analysis ③); the remaining consumers are scheduled on their own track because each is a *read* against the already-built layer, not a new integration.

| Consumer (from the map) | Reads | Prerequisite | Sequencing |
| --- | --- | --- | --- |
| ② triage floor (#361) | `deterministic_ioc && floorEligible` | P1a | **core** — ships with P1a |
| ③ story LLM analysis (C1) | `facts[]` | P1b | **core** — ships with P1b |
| ① selective retention / ingest | hit + `coverageStatus` | P1a layer + RFC 0002 ingest/readiness | after core; **async, must not gate raw ingest** |
| ⑤ periodic-report TI aggregation | stored evidence records | P1a layer + RFC 0002 report worker | after core; **reuses evidence, no new TI calls** |
| ④ event-level verdict + readiness (`runEventEnrichment`) | per-event `known_ioc_hit` + `coverage_status` + evidence | P1a layer + RFC 0002 baseline-event store | **scoped (#492)** — per-event floor v1 = story mirror |
| ④ event-level analysis (`analyzeEvent`) | `facts[]` + per-event floor | P1b layer + RFC 0001 event path + #492 verdict | deferred (facts + analyze) |
| ⑥ interactive / on-demand lookup (F1) | live enrich on demand | P1b layer + #318 F1 conversation surface | deferred |

Severity-axis use of TI (whether deterministic hits may raise `severity_score`, not just floor likelihood) is an **open question**, not a scheduled consumer — see Open questions.

---

## Testing (per #361 and beyond)

- **Fixtures are pinned local snapshots, never live feeds** — feed/API responses are committed fixtures so tests are deterministic and offline; no test queries a real TI service.
- Source-match unit tests: hit / miss / allowlist, for each entity type.
- Indicator-normalization tests: URL canonicalization, punycode/IDN, CIDR membership, private/reserved exclusion, hash-type distinction.
- Hit-type / floor-eligibility tests: `deterministic_ioc` vs `soft_reputation`; assert soft sources never set `known_ioc_hit`; assert a `deterministic_ioc` match with `floorEligible === false` does **not** set the floor.
- Stale-feed / source-error tests: a stale or failed deterministic source yields coverage status `unknown`/`stale` (recorded), **not** a silent `false`; assert `false-complete` vs `false-unknown` are distinguishable.
- Audit-record tests: a `known_ioc_hit = true` persists `sourcePolicyId`, `sourceVersion`/`feedHash`, `redactionToken`, `floorEligible`, and `checkedAt`.
- Reproducibility test: an external indicator is stored raw in `redactionToken` and re-checks against a pinned feed snapshot directly; a customer-asset indicator is stored as a token whose original is recoverable only via the existing redaction map, located by the row's `(sourceAiceId, memberEventKey)` scope (the same dependency every other consumer has). Two members reusing the same token string for different recovered values must yield distinguishable evidence rows.
- Worker integration covering `known_ioc_hit` `true` and `false`.
- Assertion that on-disk `likelihood_score` stays raw (floor affects only derived `priority_tier`).
- E2E staging (mirror #361): fixture-pinned `severityScore=0.85`, `likelihoodScore=0.3`; two distinct `story_id`s identical except derived `known_ioc_hit` (`false` vs `true`); assert `false → MEDIUM` and `true → CRITICAL`. Use two distinct `story_id`s, not two `story_version`s of one id (the canonical-version tie-breaker #343 would otherwise entangle the result). Re-confirm both matrix buckets at test-authoring time.

---

## Open questions (to settle before scoping issues)

1. **Default Tier 1 path**: lightweight in-aimer-web feed import vs requiring a local MISP from the start. (Leaning: in-aimer-web default; MISP optional.)
2. **Customer key model** for VT / GreyNoise / AbuseIPDB: confirm customer-supplied-key as the licensing mechanism; where are keys stored (OpenBao Transit?).
3. **Redaction interaction**: confirm external malicious indicators survive redaction while customer-own ranges are stripped; scope the redaction-token-aware fact-injection sub-effort.
4. **Indicator sufficiency from aice-web-next**: confirm members carry the needed indicators; if not, file a scoped sender-side gap (vs aice-web-next).
5. **Per-customer policy surface**: where/how operators enable sources and tiers (admin UI? per-customer config table?).
6. **Caching / freshness**: per-indicator cache TTL; how Tier 1 feed refresh cadence is scheduled.
7. **Cost / rate limiting**: per-enricher budgets for Tier 2 (ties to RFC 0002 Phase 4 cost monitoring).
8. **MISP adoption trigger**: when (if ever) we stand up MISP centrally vs only integrating customer-run instances.
9. **Licensing confirmation**: per-source legal review of commercial-product-use terms (abuse.ch for-profit, AbuseIPDB/GreyNoise non-commercial free tiers, VT public-API ban, Spamhaus DROP/EDROP) before any source is integrated. Resolves the provisional license tables above. The free-OSINT-feed subset surfaced by the vendor-central-MISP pivot has been re-vetted under the direct first-party model — see Appendix A.
10. **Severity-axis influence**: may a `deterministic_ioc` hit raise `severity_score` (e.g. known ransomware hash), or does TI affect *likelihood only* as today? If yes, define a severity-side mechanism analogous to the likelihood floor (and keep stored raw scores untouched, per #292).
11. **Selective-retention semantics (①)**: exactly which retention/priority decisions TI may influence, confirmed against RFC 0002's ingest/readiness state machine; reaffirm that enrichment is async and never gates raw ingest.
12. **Periodic-report TI sections (⑤)**: which aggregates belong in LIVE/DAILY/WEEKLY/MONTHLY reports, computed purely from stored evidence records (no report-time TI calls).
13. **Interactive lookup cost (⑥)**: if on-demand lookup (#318 F1) is added, its egress/cost model and per-customer opt-in (likely Tier 2 customer-key, same as ②/③).

---

## Relationships

- Floor consumer wiring: #330 / PR #339.
- RFC umbrella + floor policy ("floors apply only at matrix-lookup time; stored `likelihood_score` is raw"): #292.
- Deterministic IOC floor source (near-term, closed by Phase 1): #361.
- External TI enrichment menu item (future RFC, matured across phases): #318 C1.
- Future relationship/attribution work that may pull in OpenCTI: #318 B1 / E1 / E3.
- Canonical story-version tie-breaker (E2E constraint): #343.
- Story analysis manual (floor + enrichment documentation): #342.
- Redaction foundation: RFC 0001; story-level redaction stance: RFC 0002.

## Candidate implementation issues (to be written from this doc)

- [ ] **(P1a)** Enricher interface + per-entity dispatch + per-match `hitType` / `floorEligible` / `sourcePolicyId` model + source-policy registry + indicator normalization (foundation).
- [ ] **(P1a)** Tier 1 abuse.ch / Spamhaus-style **IOC**-feed import + local matching + audit/evidence record (redaction-consistent `redactionToken`: external raw / customer-asset token + `sourceVersion`/`feedHash`) + coverage status + `known_ioc_hit` wiring into `applyLikelihoodFloors` (**closes #361**).
- [ ] **(P1a)** Feed-refresh worker + stale-feed → `unknown`/`stale` coverage status (not silent `false`) policy.
- [ ] **(P1b)** Redaction-token-aware enrichment fact injection (RFC 0001 extension) + worker execution-order guard.
- [ ] Per-customer enable flags + policy surface.
- [ ] **(P2)** Tier 2 IP enrichers (GreyNoise / AbuseIPDB / Shodan InternetDB), customer-key model, opt-in + per-customer egress audit log.
- [ ] **(P3)** Tier 2 VirusTotal adapter (customer key / VT Enterprise), rate/cost limiting.
- [ ] API-key lifecycle (OpenBao storage, rotation, deletion/revocation).
- [ ] **(P4)** MISP / STIX-TAXII adapter.
- [ ] Per-source licensing legal review (Open question 9) — gates each source.
- [ ] Tests (unit / normalization / stale-feed / audit / worker / E2E) per Testing section.
- [ ] Manual update (#342).

Additional consumers (own track, read against the existing layer — see TI consumer map):

- [ ] **(consumer ①)** Selective-retention / ingest-priority signal — async, never gates raw ingest (Open question 11).
- [x] **(consumer ④, verdict)** Per-event IOC **verdict + readiness** for a loose baseline event — `runEventEnrichment(customerId, sourceAiceId, eventKey)` + the `(source_aice_id, event_key)`-grain `event_enrichment_state` / `event_ioc_evidence` tables (#492). The tier-A prerequisite for RFC 0002's individual baseline-event auto-analysis (#489); v1 per-event floor = story #361 mirror. **Not** the completion of ④: event-level narrative facts and the per-event `analyzeEvent` path remain deferred.
- [ ] **(consumer ④, facts + analyze)** Event-level **fact-injection** for `analyzeEvent` (per-event `story_enrichment_fact` analog + the per-event LLM analyze path), RFC 0001 path — builds on the #492 verdict.
- [ ] **(consumer ⑤)** Periodic-report TI aggregation from stored evidence records — no report-time TI calls (Open question 12).
- [ ] **(consumer ⑥)** Interactive / on-demand TI lookup tied to #318 F1 (Open question 13).
- [ ] **(decision)** Severity-axis influence of deterministic hits (Open question 10) — resolve before building a severity-side mechanism.

---

## Appendix A: Free-feed licensing re-vetting (direct first-party commercial-use lens)

*Recorded 2026-06-14; revised after review with current-source verification. Re-vets the free-OSINT-feed set surfaced while a vendor-central MISP was being considered as the enrichment vehicle, plus a broader sweep of additional candidates — MISP default feeds, vendor IOC repositories, a negative (false-positive-suppression) source, and CVE/vulnerability-context sources. This is a record, not a license; the per-source confirmation gate (Open question 9) still applies before any source is integrated.*

### Why a re-vetting was needed (the lens shift)

The earlier survey of these feeds assumed a **redistribution** model: a central MISP fetching feeds and **redistributing** them to the customer fleet. Under that standard almost every free feed was blocked, because nearly all free OSINT feeds forbid commercial **redistribution**.

RFC 0003 does not redistribute. The enrichment layer lives **inside aimer-web** (§"Pluggable enricher interface"), and Tier 1 works by **importing feed files into local storage and matching locally** — the instance fetches each feed **directly** and uses the indicators internally to enrich its own analysis output, without handing the raw feed to customers or third parties (§"Source taxonomy: two tiers by egress"). That is **first-party use, not redistribution**, so the governing licence test shifts:

- **Redistribution-only restrictions** (resale / no-resharing) — **may now be satisfied**, because we neither resell nor reshare the raw feed.
- **Commercial-*use* prohibitions, NonCommercial (CC-NC*) licences, and no-licence / no-grant feeds** — **still blocked**, because the limiting factor is the commercial *nature of the use* (or the absence of any grant), which direct fetching does not change.

This is the same axis RFC 0003 already names as the "real trap" in §"Source catalog" (free-to-use ≠ free-to-embed-in-a-commercial-product). The re-vetting applies that test, feed by feed, against each source's **current** primary terms.

### Per-feed verdicts

Verdict legend: **USE-OK-DIRECT** = usable for direct first-party internal enrichment as scoped above; **BLOCKED-DIRECT** = not usable even first-party; **NEEDS-CONTACT** = no affirmative grant, requires written permission; **PAID-ONLY** = commercial use requires the vendor's paid tier; **TIER2-SOFT-ONLY** = usable only as an opt-in egress soft-reputation lookup, never a local deterministic floor source.

| Source | Indicators | Prior verdict (redistribution lens) | Re-vetting verdict (direct first-party) | Deciding clause | Conf. |
| --- | --- | --- | --- | --- | --- |
| **CIRCL OSINT feed** | IP / domain / URL / hash **+ rich tags & galaxies** | FLAGGED (assumed TLP:GREEN mix) | ⚠️ **NEEDS-CONTACT** (sharing OK, licence not established) | Feed is marked **TLP:CLEAR** (not GREEN), but **TLP is a disclosure-handling marking, not a licence** (FIRST: TLP:CLEAR is "subject to standard copyright rules"). CIRCL ships **no explicit data licence**, so unrestricted *sharing* ≠ a grant to **store and commercially reuse** the curated content — especially the copyrightable tags/galaxies we actually want. Practical risk is low (CIRCL publishes for community use); a one-line CIRCL confirmation resolves it | Med |
| **Botvrij.eu** | IP / domain / URL / hash | BLOCKED (resell prohibited) | ✅ **USE-OK-DIRECT** | "You can use this data the way you prefer"; the **only** carve-out is "You cannot **resell** the data" — resale ≠ internal use | Med-High |
| **DigitalSide Threat-Intel** | malware IP / domain / URL / hash | BLOCKED (recorded as CC-BY-NC-SA) | ✅ **USE-OK-DIRECT** *(prior verdict was a factual error)* | Actually **MIT + TLP:WHITE**; no NC clause exists. The CC-NC-SA label appears to have been confused with abuse.ch terms — this is a correction, not a lens change. Confidence tempered: the MIT LICENSE's copyright names a web-template vendor (Blackrock Digital), so MIT's coverage of the *feed data* (vs repo scaffolding) is worth a legal-gate re-confirm | Med |
| **PhishTank** | phishing URL | BLOCKED (assumed non-commercial free tier) | ⚠️ **licence OK, operationally deferred** | FAQ: commercial use "Yes, it is OK", data free, no paid tier — but **new registration is temporarily disabled**, so the app key needed for automated fetch cannot currently be obtained | Med-High |
| **CINS / CI Army** | IP (noisy) | BLOCKED (commercial-product use) | ⚠️ **NEEDS-CONTACT** (low value → skip) | cinsscore.com grants "you can **parse and use [the list] in any way you see fit**" (so the earlier "no affirmative grant" was wrong), but this informal sentence **does not address commercial-product embedding**, and the only formal EULA governs Sentinel **software**, not the list. No NC clause; commercial embedding neither granted nor forbidden | Med |
| **blocklist.de** | IP (noisy) | FLAGGED (no licence) | ⚠️ **NEEDS-CONTACT / no-grant** (low value → skip) | No licence; "free" is scoped to **reporters** and explicitly excepts "Download der Listen bei zu großem Volumen" — i.e. our automated high-volume fetch pattern | High (that no grant exists) |
| **Binary Defense banlist** | IP | BLOCKED | ❌ **BLOCKED-DIRECT** (confirmed) | Feed-file header: "Use of these feeds for **commerical** … use is **strictly prohibited**"; bars "products that are charging fees" — a commercial-**use** ban, not a redistribution one | High |
| **C2IntelFeeds** | C2 IP / domain | BLOCKED (CC-BY-NC) | ❌ **BLOCKED-DIRECT** (confirmed; actually **CC-BY-NC-SA**) | CC NonCommercial bars use "primarily intended for or directed towards commercial advantage"; internal use in a paid product is commercial use, independent of redistribution. ShareAlike adds a copyleft obstacle | High |
| **C2-Tracker** | C2 IP | BLOCKED (no licence) | ❌ **BLOCKED-DIRECT** (confirmed + dead) | **No licence** (default all-rights-reserved); data is **Shodan-owned** upstream (Shodan ToS §10.1/§6.5); repo **archived 2026-04** → stale/"data death" | High |
| **OpenPhish** (community) | phishing URL | BLOCKED | ❌ **BLOCKED-DIRECT / PAID-ONLY** | "Non-commercial use only"; ToU: "not use any part of the Services for any commercial purposes without … prior written consent". Commercial = paid Premium/Database tier | High |
| **ET Open** (bundled IP lists) | IP | Partial | ❌ **BLOCKED-DIRECT** (for the IP lists) | `emerging-Block-IPs.txt` commingles **Spamhaus** (commercial use not free; copyright + database right) under ET's BSD wrapper — an aggregator's BSD notice cannot relicense third-party data; `compromised-ips.txt` is unlicensed. The ET **rules** are BSD but are detection signatures, **out of scope** for IOC enrichment | High |

### Additional candidates (MISP default-feed sweep — beyond the original fountel set)

A review surfaced further free feeds outside the original BLOCKED/FLAGGED set; vetted here under the same lens. Note none of the licence-clean ones carries CIRCL-style rich context — they are bare membership feeds.

| Source | Indicators | Re-vetting verdict | Deciding clause | Conf. |
| --- | --- | --- | --- | --- |
| **Infoblox Threat Intelligence** | domain-heavy (+ IP / URL / hash / email) | ✅ **USE-OK-DIRECT** | **CC-BY-4.0**; README: the data is provided "to use it for both commercial and non-commercial security purposes, under … attribution to Infoblox". Licence covers the **data** (only the unused `sample-code` folder is GPL). **But content is a bare membership/severity list — no galaxies / actor / malware tags** (rich "decision criteria" is paywalled in Infoblox TIDE), so it is a clean deterministic feed, **not** a thick-context replacement for CIRCL. Attribution is a hard CC-BY obligation | High |
| **Phishing.Database** | phishing domain / URL / IP | ✅ **USE-OK-DIRECT** | **MIT**, covering the data ("without restriction … sell"); actively updated (~0.5M domains). Bulk membership lists (no context). Low upstream risk — community-contributed and PyFunceble-validated (it is itself a VirusTotal data vendor), not a republication of a restricted feed; contamination would matter only if we ever redistribute | High |
| **CERT Polska Warning List** | active phishing domains (PL-centric) | ✅ **USE-OK-DIRECT** | The grant — data "may be **accessed, used and processed without obtaining special permission or license**" — is in the CERT-Polska/phishing-api spec, **now an archived repo**; the current cert.pl warning-list page exposes the v2 endpoints (`hole.cert.pl/domains/v2/`) but carries **no licence text**, so re-confirm the grant before relying on it. No commercial bar / no registration for the pull endpoints; best-effort (no SLA) | Med |
| **PhishStats** | phishing URL / IP | ⚠️ **NEEDS-CONTACT** (no-grant) | No licence or terms anywhere ("free for research" only); a paid "Premium API" tier is "coming"; CSV deprecated → 20 req/min JSON API behind Cloudflare | High (no grant) |
| **Threatview.io** | C2 / IP / domain / hash | ⚠️ **NEEDS-CONTACT** (no-grant) | Site footer is "**All rights reserved by Threatview.io**" with no usage terms; "freely usable" is an aggregator's label, not Threatview's own grant | High (no grant) |

### Vendor IOC repositories (first-party research — cleaner licences, report-level context)

Public vendor/research IOC repos are higher-provenance than community blocklists and ship indicators **bundled with report context** (threat actor, campaign, malware family, blog link) — clean-licensed narrative material that partially fills the gap left by CIRCL. All are first-party research (no upstream laundering); licences were verified verbatim. The cost is a **generic GitHub IOC parser**: formats are heterogeneous per report, and several carry ingestion hazards.

| Repo | Licence (verified) | Verdict | Content / context | Ingestion caveat |
| --- | --- | --- | --- | --- |
| **Unit 42** (Palo Alto) | Unlicense (public domain) | ✅ USE-OK-DIRECT | richest narrative (prose notes, actor IDs) | defanged free-text + a PDF — highest parser cost |
| **ESET** malware-ioc | BSD-2-Clause (README applies it to the data) | ✅ USE-OK-DIRECT | report-context (AsciiDoc tables + hash lists + YARA/Snort) | AsciiDoc-table parsing |
| **Volexity** threat-intel | BSD-2-Clause (in `LICENSE.txt`) | ✅ USE-OK-DIRECT | report-context (`iocs.csv` with described roles) | licence in `LICENSE.txt` → SPDX scanners read NOASSERTION; "rules" wording vs CSV data is the one soft spot |
| **PRODAFT** malware-ioc | MIT | ✅ USE-OK-DIRECT | richest report-context (per-campaign READMEs) | **ships 16 live `.exe` malware samples** — allowlist parseable IOC files, never write/execute binaries |
| **Zscaler** ThreatLabz | MIT | ✅ USE-OK-DIRECT | folder/filename context, bare lists | defanged `[.]`; skip `.php`/`.hta` artifacts |
| **Huntress** threat-intel | MIT (README reaffirms) | ✅ USE-OK-DIRECT | report-context but **~90% Sigma/YARA detections, low atomic-IOC yield** | low IOC volume; author disclaims correctness |
| **Meta** threat-research | MIT (README applies it to the data) | ✅ USE-OK-DIRECT *(filtered)* | mostly **CIB / influence-ops**, not malicious infrastructure | **classification hazard** — ingest only the malware-report CSVs; CIB indicators (social URLs, account counts) must NOT be `deterministic_ioc` |

These are the first **confirmed-clean** source of C1 narrative context: their report-level context (actor/campaign/family) is coarser than CIRCL's per-indicator galaxies but is first-party and licence-clean. Genuine compromise IOCs within them are also `deterministic_ioc`-capable per the §"the type-distinction hinge" classification.

### Negative source (false-positive suppression)

| Source | Licence | Verdict | Role |
| --- | --- | --- | --- |
| **MISP warninglists** | CC0 | ✅ USE-OK-DIRECT | **NOT a known-bad feed** — known-good / known-noisy lists (public resolvers, CDNs, bogons, top-sites) used as an **exclude / down-weight layer** to raise floor quality. Must never feed `known_ioc_hit` |

### Vulnerability / CVE-context sources (separate consumer track)

These match **CVE** indicators, not IOCs — they feed C1 narrative and a future vulnerability-enrichment + severity track (OQ10), **not** the #361 deterministic floor. The CVE *consumer build* remains its own effort (the RFC's "KEV/NVD not P1a" note); only the **source licences** are vetted here.

| Source | Licence | Verdict | Note |
| --- | --- | --- | --- |
| **GitHub Advisory Database** | CC-BY-4.0 | ✅ USE-OK-DIRECT | whole DB (reviewed + NVD-imported); attribution by link |
| **OSV** (osv.dev) | per-source (CC-BY / CC0 / MIT / Apache; **Ubuntu CC-BY-SA**) | ✅ USE-OK-DIRECT | aggregation layer; honour each record's upstream licence; Ubuntu ShareAlike only bites on redistribution |
| **FIRST EPSS** | "granted … freely to the public" | ✅ USE-OK-DIRECT | exploit-probability score; attribution requested (soft); webpage grant — snapshot at integration |
| **Google Project Zero 0days** | Apache-2.0 | ✅ USE-OK-DIRECT | in-the-wild-0day context; low cadence, narrow coverage |
| **CISA Vulnrichment** | CC0-1.0 | ✅ USE-OK-DIRECT *(optional)* | SSVC / KEV / CVSS / CWE enrichment of CVEs; README notes it is **redundant if already consuming live CVE data**, so optional |

### Held / excluded (broader sweep)

| Source | Verdict | Reason |
| --- | --- | --- |
| **Cisco Talos IOCs** | ⚠️ NEEDS-CONTACT | No licence file, but README invites use "in your blocklists (or other relevant security software)" — the best candidate to flip with a one-line Cisco confirmation on commercial ingestion |
| **SophosLabs IoCs** | ⚠️ NEEDS-CONTACT | No grant at all (and Sophos is a direct competitor) |
| **JPCERT phishurl-list** | ⚠️ NEEDS-CONTACT | No grant in the repo; JPCERT's site policy may not extend to this dataset |
| **ThreatMiner** | ⛔ TIER2-SOFT-ONLY | Site is CC-BY-4.0 but it **aggregates VirusTotal / Hybrid-Analysis / OTX** — a CC-BY wrapper cannot relicense upstream-restricted data, so it is unsafe as a deterministic floor; at best a low-trust Tier-2 soft lookup. Liveness shaky |
| **urlscan.io** | ⛔ PAID-ONLY | Free tier: "Commercial use of any part of our service requires express written permission" |
| **Pulsedive** | ⛔ PAID-ONLY / NEEDS-CONTACT | No clean free-tier commercial grant ("re-selling / paid client access → custom licensing"); free key 100 req/month |

### Outcome and implications for the source catalog

- **Clean, commercially usable Tier 1 additions** (beyond the abuse.ch / Spamhaus / KEV / NVD / MITRE set already in §"Tier 1"), each a `deterministic_ioc`-capable local feed that slots into the Phase 1a framework as an **"add a source" adapter** (the path abuse.ch already uses), subject to the §"the type-distinction hinge" per-match classification:
  - **Infoblox TI** (CC-BY-4.0) — clean commercial grant; DNS/domain-heavy membership + severity. Requires an "Infoblox Threat Intel, CC-BY-4.0" attribution wherever matched indicators surface.
  - **Phishing.Database** (MIT) and **CERT Polska Warning List** (archived-spec data grant, re-confirm) — phishing-domain membership, filling the gap left by OpenPhish (blocked) and PhishTank (parked).
  - **Botvrij.eu** (resale-only restriction) — general IOC coverage.
  - **DigitalSide** (MIT/TLP:WHITE, confidence Med) — malware-focused IOCs.
- **Thick LLM context now has a *confirmed-clean* path — vendor IOC repositories.** CIRCL OSINT (the one *per-indicator* galaxy/tag source) is still **NEEDS-CONTACT** and Infoblox is a bare list, but the **vendor research repos** (Unit 42, ESET, Volexity, PRODAFT, Zscaler, Huntress, Meta — Unlicense / BSD / MIT) ship IOCs **bundled with report context** (actor, campaign, malware family) under clean, verified licences. That context is coarser than CIRCL's per-indicator galaxies but is **first-party and licence-clean**, so it is the first confirmed-clean source of C1 narrative material. CIRCL remains worth a one-line grant ask for finer per-indicator tags; if cleared, apply a per-event TLP filter so anything above TLP:GREEN never surfaces outside per-customer context, and attribute "CIRCL OSINT Feed" provenance per §"Audit / evidence model".
- **Broader sweep (see the four tables above).** Vendor IOC repos are licence-clean and high-provenance but need a **generic GitHub IOC parser** plus ingestion guards — PRODAFT ships live `.exe`, Meta is mostly influence-ops/CIB that must **not** be classed `deterministic_ioc`, several feeds are defanged, and Huntress is low-yield. **MISP warninglists** (CC0) is a **negative / FP-suppression** layer that raises floor quality (never a known_ioc_hit). **CVE-context sources** (GitHub Advisory, OSV, EPSS, Project Zero, CISA Vulnrichment) are all licence-clean but feed the **separate CVE / severity track**, not the IOC floor. **Held / excluded:** Talos / Sophos / JPCERT (no grant → NEEDS-CONTACT; Talos closest to flippable), ThreatMiner (aggregation-laundering → Tier-2 soft only), urlscan.io / Pulsedive (commercial = paid).
- **Confirmed-blocked feeds** (Binary Defense, C2IntelFeeds, C2-Tracker, OpenPhish, ET Open IP lists) are not pursued under the free/direct model; any future use needs the vendor's paid/commercial path.
- **ET Open adds nothing new:** its atomic IP lists commingle Spamhaus (commercial use not free), so the bundle is blocked. Its cleanest underlying source is **abuse.ch — already integrated directly**, though abuse.ch's own commercial terms are *conditional*, not CC0 (see correction below), so this is not a free shortcut either.
- **Correction — abuse.ch is not a blanket "CC0 / commercially clean" source.** Only **Feodo Tracker** states CC0; **URLhaus, ThreatFox, MalwareBazaar** are **conditional** (Auth-Key required; commercial/for-profit use "may require a paid subscription" via the Spamhaus-managed commercial API), and abuse.ch's umbrella Terms of Use gate commercial-volume access. This matches the RFC body's existing §"Tier 1" wording ("⚠️ conditional"); the earlier "abuse.ch CC0" phrasing in this appendix was wrong.
- **Skip — gray-zone / no-grant, low value or operationally stuck:** CINS and blocklist.de (noisy IPs; CINS grants generic use but not commercial embedding, blocklist.de has no grant) and PhishStats / Threatview.io (no licence at all) — **not worth a NEEDS-CONTACT** outreach. **PhishTank** is parked: its licence permits commercial use, but new registration is disabled, so revisit if/when an app key becomes obtainable.

### Primary sources

- CIRCL OSINT — [misp-circl-feed repo / README (TLP:CLEAR)](https://codeberg.org/adulau/misp-circl-feed), [CIRCL MISP service](https://www.circl.lu/services/misp-malware-information-sharing-platform/), [FIRST TLP](https://www.first.org/tlp/)
- Botvrij.eu — [homepage "Terms of use" footer](https://www.botvrij.eu/)
- DigitalSide — [LICENSE (MIT)](https://raw.githubusercontent.com/davidonzo/Threat-Intel/master/LICENSE), [feed manifest (TLP:WHITE)](https://raw.githubusercontent.com/davidonzo/Threat-Intel/master/digitalside-misp-feed/manifest.json)
- PhishTank — [FAQ (commercial OK / free)](https://phishtank.org/faq.php), [registration disabled](https://www.phishtank.com/register.php)
- CINS / CI Army — [cinsscore.com](http://cinsscore.com/), [cinsarmy.com](https://cinsarmy.com/), [software EULA (PDF)](https://cinsarmy.com/wp-content/uploads/2017/10/EULA_2017.pdf)
- blocklist.de — [terms (EN/DE)](https://www.blocklist.de/en/terms.html), [imprint](https://www.blocklist.de/de/imprint.html)
- Binary Defense — [banlist.txt (header terms)](https://www.binarydefense.com/banlist.txt)
- C2IntelFeeds — [License.md (CC-BY-NC-SA-4.0)](https://github.com/drb-ra/C2IntelFeeds/blob/master/License.md)
- C2-Tracker — [repo (no licence, archived)](https://github.com/montysecurity/C2-Tracker), [Shodan ToS](https://static.shodan.io/legal/terms.html)
- OpenPhish — [Terms of Use](https://openphish.com/terms.html), [community feed README](https://github.com/openphish/public_feed)
- ET Open — [emerging-Block-IPs.txt](https://rules.emergingthreats.net/fwrules/emerging-Block-IPs.txt), [Spamhaus DROP terms](https://www.spamhaus.org/drop/terms/)
- abuse.ch (correction) — [Feodo Tracker (CC0)](https://feodotracker.abuse.ch/blocklist/), [URLhaus API (conditional — commercial may require paid)](https://urlhaus.abuse.ch/api/), [abuse.ch Terms of Use](https://abuse.ch/terms-of-use/)
- Infoblox TI — [LICENSE (CC-BY-4.0)](https://raw.githubusercontent.com/infobloxopen/threat-intelligence/main/LICENSE), [README (commercial-use grant)](https://github.com/infobloxopen/threat-intelligence)
- Phishing.Database — [LICENSE (MIT)](https://raw.githubusercontent.com/Phishing-Database/Phishing.Database/master/LICENSE), [repo](https://github.com/Phishing-Database/Phishing.Database)
- CERT Polska Warning List — [warning list page (v2 endpoints; no licence text)](https://cert.pl/en/warning-list/), [API spec with the data grant — **archived repo**](https://raw.githubusercontent.com/CERT-Polska/phishing-api/master/SPECIFICATION.md)
- PhishStats — [FAQ (no terms)](https://phishstats.info/faq); Threatview.io — [site ("all rights reserved")](https://threatview.io/)
- Vendor IOC repos — [Unit 42 (Unlicense)](https://github.com/PaloAltoNetworks/Unit42-Threat-Intelligence-Article-Information), [ESET (BSD-2, README)](https://github.com/eset/malware-ioc), [Volexity (BSD-2, `LICENSE.txt`)](https://github.com/volexity/threat-intel), [PRODAFT (MIT)](https://github.com/prodaft/malware-ioc), [Zscaler ThreatLabz (MIT)](https://github.com/threatlabz/iocs), [Huntress (MIT)](https://github.com/huntresslabs/threat-intel), [Meta (MIT)](https://github.com/facebook/threat-research)
- MISP warninglists — [README (CC0)](https://github.com/MISP/misp-warninglists)
- CVE-context — [GitHub Advisory DB (CC-BY-4.0)](https://docs.github.com/en/github/site-policy/github-terms-for-additional-products-and-features), [OSV data sources](https://google.github.io/osv.dev/data/), [EPSS FAQ](https://www.first.org/epss/faq), [Project Zero 0days (Apache-2.0)](https://github.com/googleprojectzero/0days-in-the-wild), [CISA Vulnrichment (CC0-1.0)](https://github.com/cisagov/vulnrichment)
- Held / excluded — [Cisco Talos IOCs](https://github.com/Cisco-Talos/IOCs), [SophosLabs IoCs](https://github.com/sophoslabs/IoCs), [JPCERT phishurl-list](https://github.com/JPCERTCC/phishurl-list), [ThreatMiner (CC-BY, aggregator)](https://www.threatminer.org/api.php), [urlscan.io terms](https://urlscan.io/terms/), [Pulsedive terms](https://pulsedive.com/terms)
