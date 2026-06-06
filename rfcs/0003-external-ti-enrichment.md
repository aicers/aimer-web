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
| ④ | **aimer-web event-level LLM analysis** (`analyzeEvent`, RFC 0001) | Yes (deferred) | same fact-injection, scoped to a single `(aice_id, event_key)`; a per-event floor **requires its own floor policy — it is not inherited automatically from the story-level #361 policy** (different policy surface, defined when ④ is scoped) | sync at analysis time | yes (deterministic, separate policy) | deferred |
| ⑤ | **aimer-web periodic reports** (LIVE/DAILY/WEEKLY/MONTHLY) | Yes | aggregate TI signal into reports — "N known-IOC matches this week", newly-observed C2 infrastructure, feed-membership trend, top malicious ASNs — **reusing stored evidence records, no new TI calls** | async (report generation) | no | later |
| ⑥ | **aimer-web interactive / on-demand lookup** (follow-up Q&A, analyst manual check; #318 F1) | Yes (deferred) | operator asks "is this indicator malicious now?" at query time | sync on demand | no | deferred |

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

Matching is only as good as normalization. A normalized indicator is the value actually matched and stored in the audit record. Rules to define (v1):

- **URL** — canonicalization (scheme/host casing, default ports, path/query normalization, percent-encoding); decide whether to match URL, host, and registered domain separately.
- **Domain** — lowercase, trailing-dot strip, **punycode / IDN** normalization (match both U-label and A-label).
- **IP** — IPv4/IPv6 canonical form; **CIDR** membership matching; **private/reserved vs public** classification (private/reserved never sent to Tier 2 and never floor-eligible).
- **Hash** — distinguish hash type (MD5 / SHA-1 / SHA-256); normalize casing.
- Record the normalization version so audit records remain interpretable as rules evolve.

### Audit / evidence model

`reproducible / auditable` (Summary) requires storing *why* a result was produced, not just the boolean. A `known_ioc_hit = true` must be explainable after the fact, so persist an evidence record alongside the story result.

**Indicator storage is redaction-consistent.** The evidence record stores the indicator exactly the way the rest of the system already does — there is no separate HMAC scheme. The **`redactionToken`** carries the indicator: the **raw value for an external indicator** and a **`<<REDACTED_*_NNN>>` token for a customer-asset indicator** (whose original lives only in the existing encrypted redaction map). Each record stores:

- the **`redactionToken`** (raw external indicator, or the customer-asset token whose original is in the redaction map),
- which **source** (`sourcePolicyId`) and **source/feed version** (`sourceVersion` / `feedHash`),
- the resulting **`hitType`** and **`floorEligible`**,
- the **match timestamp** (`checkedAt`) and cache `expiresAt`.

**Reproducibility.** An external indicator is **self-sufficient** — the raw value in `redactionToken` can be re-checked against a feed snapshot directly. A customer-asset indicator is recoverable via the **existing redaction map** (the same dependency every other consumer already has), so it can be re-checked too. This is the same trade-off the redaction layer makes everywhere; evidence does not add a second mechanism.

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
| ④ event-level analysis (`analyzeEvent`) | `facts[]` + per-event floor | P1b layer + RFC 0001 event path | deferred |
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
- Reproducibility test: an external indicator is stored raw in `redactionToken` and re-checks against a pinned feed snapshot directly; a customer-asset indicator is stored as a token whose original is recoverable only via the existing redaction map (the same dependency every other consumer has).
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
9. **Licensing confirmation**: per-source legal review of commercial-product-use terms (abuse.ch for-profit, AbuseIPDB/GreyNoise non-commercial free tiers, VT public-API ban, Spamhaus DROP/EDROP) before any source is integrated. Resolves the provisional license tables above.
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
- [ ] **(consumer ④)** Event-level enrichment for `analyzeEvent` (per-event facts + floor), RFC 0001 path.
- [ ] **(consumer ⑤)** Periodic-report TI aggregation from stored evidence records — no report-time TI calls (Open question 12).
- [ ] **(consumer ⑥)** Interactive / on-demand TI lookup tied to #318 F1 (Open question 13).
- [ ] **(decision)** Severity-axis influence of deterministic hits (Open question 10) — resolve before building a severity-side mechanism.
