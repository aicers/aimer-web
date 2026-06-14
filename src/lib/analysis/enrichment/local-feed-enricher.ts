// RFC 0003 P1a (#361) — Tier-1 local-feed enricher + source policies.
//
// A DB-backed `Enricher` that matches a `NormalizedIndicator` against an
// imported feed snapshot (`ioc_feed_snapshot`, dedicated feed DB #564) and
// returns an `EnrichmentResult`. Matching is local: only the feed
// download leaves the host (the import path), never the customer's
// observed indicators. This follows the reference `FixtureEnricher`
// pattern (#427) — one enricher per feed/policy — but reads a real,
// pinned-or-imported snapshot through an injectable `FeedStore` so unit
// tests can run against an in-memory store with no DB.
//
// The licensing gate (RFC 0003 Open Q#9): every policy below ships with
// `floorEligible: false`, so a match can be produced for narrative /
// coverage but cannot drive the binary floor until a feed's
// commercial-product-use terms are confirmed. Flipping a feed to
// `floorEligible: true` is then a policy-registry change with no code
// change — the dispatcher re-derives `floorEligible` from the active
// policy on every match.

import { EnrichmentDispatcher } from "./dispatcher";
import { createEnrichmentFact } from "./fact";
import type { SourcePolicy } from "./source-policy";
import { SourcePolicyRegistry } from "./source-policy";
// Importing the barrel runs every source's `registerTiSource` side effect, so
// the registry is populated before `LOCAL_FEED_POLICIES` derives from it below.
import "./sources";
import { allTiSourceDescriptors } from "./sources/registry";
import type {
  Enricher,
  EnricherError,
  EnrichmentContextPayload,
  EnrichmentFact,
  EnrichmentMatch,
  EnrichmentResult,
  EntityType,
  HitType,
  NormalizedIndicator,
  SourceOutcome,
} from "./types";

/**
 * Build one narrative fact per match (RFC 0003 C1 / #440). Facts carry
 * the RAW indicator text at generation — redaction happens later at the
 * DB-write boundary in the enrichment worker, where customer-asset
 * indicators are tokenized and external ones stay raw. Facts are
 * produced for EVERY match, including `soft_reputation` /
 * floor-ineligible ones: a non-flooring hit still has narrative value
 * for the analyst even though it never drives the binary floor.
 *
 * Source-aware (RFC 0003 F6, #594): when a match carries a
 * `contextPayload` (vendor IOC repositories bundle report-level context),
 * the fact is enriched with the attributed actor / campaign / malware
 * family and a report link. It degrades gracefully to the bare
 * "{indicator} is listed by {source} [as {classification}]" one-liner when
 * no context is present — so the existing five context-less feeds produce
 * byte-identical facts.
 */
export function buildFactsFromMatches(
  indicator: NormalizedIndicator,
  matches: ReadonlyArray<EnrichmentMatch>,
): EnrichmentFact[] {
  return matches.map((match) =>
    createEnrichmentFact(buildFactText(indicator, match)),
  );
}

/** The source-aware narrative for one match (see `buildFactsFromMatches`). */
function buildFactText(
  indicator: NormalizedIndicator,
  match: EnrichmentMatch,
): string {
  let text =
    `${indicator.value} is listed by ${match.source}` +
    (match.classification ? ` as ${match.classification}` : "");
  const context = match.contextPayload;
  if (context) {
    const attribution = buildAttributionClause(context);
    if (attribution) text += `; ${attribution}`;
    if (context.reportUrl) text += `; see ${context.reportUrl}`;
  }
  return text;
}

/**
 * The attribution clause from a context payload — "attributed to {actor} in
 * campaign {campaign} (family {malwareFamily})" — degrading to whichever
 * fields are present (any subset may be absent). Returns "" when none of
 * actor / campaign / malwareFamily are present (the report link is appended
 * separately by the caller).
 */
function buildAttributionClause(context: EnrichmentContextPayload): string {
  const parts: string[] = [];
  if (context.actor) parts.push(`attributed to ${context.actor}`);
  if (context.campaign) {
    parts.push(
      context.actor
        ? `in campaign ${context.campaign}`
        : `campaign ${context.campaign}`,
    );
  }
  let clause = parts.join(" ");
  if (context.malwareFamily) {
    clause = clause
      ? `${clause} (family ${context.malwareFamily})`
      : `family ${context.malwareFamily}`;
  }
  return clause;
}

/** Snapshot-level provenance/freshness for one feed (per `source_policy_id`). */
export interface FeedSnapshotMeta {
  /** `false` when no snapshot has been imported for this source yet. */
  present: boolean;
  sourceVersion?: string;
  feedHash?: string;
  /** ISO timestamp of when the snapshot's feed was last refreshed. */
  sourceUpdatedAt?: string;
}

/** One matching row from a feed snapshot. */
export interface FeedMatchRow {
  hitType: HitType;
  classification?: string;
  confidence?: number;
  /**
   * Per-row report-level context (RFC 0003 F6, #594), already narrowed from
   * the snapshot's `context` JSONB by the store. Absent for context-less
   * feeds.
   */
  contextPayload?: EnrichmentContextPayload;
  sourceVersion?: string;
  feedHash?: string;
  sourceUpdatedAt?: string;
}

/**
 * Storage abstraction over `ioc_feed_snapshot`. The pg implementation is
 * `PgFeedStore` (feed-store.ts); unit tests inject an in-memory fake.
 */
export interface FeedStore {
  /** Snapshot metadata for a source, used to report answered/fresh/stale. */
  probe(sourcePolicyId: string): Promise<FeedSnapshotMeta>;
  /** Matching rows for an indicator within one source's snapshot. */
  match(
    sourcePolicyId: string,
    indicator: NormalizedIndicator,
  ): Promise<FeedMatchRow[]>;
}

/** Candidate strings a feed entry's exact value may match against. */
export function candidateValues(indicator: NormalizedIndicator): string[] {
  const values = [...indicator.matchValues];
  if (indicator.derived) {
    values.push(indicator.derived.url, indicator.derived.host);
    if (indicator.derived.registeredDomain) {
      values.push(indicator.derived.registeredDomain);
    }
  }
  // De-duplicate while preserving order — a URL whose host equals its
  // registered domain would otherwise repeat.
  return [...new Set(values)];
}

/**
 * A local-feed enricher backing exactly one source policy. `floorEligible`
 * on each emitted match is taken from the policy, but the dispatcher
 * re-derives it from the registry (and applies the non-public-IP
 * override), so the registry — not this adapter — is the floor authority.
 *
 * Coverage semantics: a present snapshot always emits a clean answered
 * outcome (`answered: true`, possibly zero matches) carrying the
 * snapshot's `sourceUpdatedAt` so the dispatcher can classify fresh vs
 * stale. A missing snapshot (feed never imported / wiped) emits an
 * `unavailable` error + non-answered outcome, so coverage degrades to
 * `unknown` rather than a silent clean `false`.
 */
export class LocalFeedEnricher implements Enricher {
  private readonly policy: SourcePolicy;
  private readonly source: string;
  private readonly store: FeedStore;

  constructor(args: {
    policy: SourcePolicy;
    source: string;
    store: FeedStore;
  }) {
    this.policy = args.policy;
    this.source = args.source;
    this.store = args.store;
  }

  supports(entityType: EntityType): boolean {
    return this.policy.entityTypes.includes(entityType);
  }

  async enrich(indicator: NormalizedIndicator): Promise<EnrichmentResult> {
    const sourcePolicyId = this.policy.sourcePolicyId;
    const probe = await this.store.probe(sourcePolicyId);
    if (!probe.present) {
      const error: EnricherError = {
        sourcePolicyId,
        kind: "unavailable",
        message: "no feed snapshot imported for source",
      };
      const outcome: SourceOutcome = {
        sourcePolicyId,
        answered: false,
        error,
      };
      return {
        indicator,
        matches: [],
        facts: [],
        errors: [error],
        outcomes: [outcome],
        checkedAt: "",
      };
    }

    const rows = await this.store.match(sourcePolicyId, indicator);
    const matches: EnrichmentMatch[] = rows.map((row) => ({
      source: this.source,
      sourcePolicyId,
      hitType: row.hitType,
      floorEligible: this.policy.floorEligible,
      classification: row.classification,
      confidence: row.confidence,
      contextPayload: row.contextPayload,
      sourceVersion: row.sourceVersion ?? probe.sourceVersion,
      feedHash: row.feedHash ?? probe.feedHash,
      sourceUpdatedAt: row.sourceUpdatedAt ?? probe.sourceUpdatedAt,
    }));

    const outcome: SourceOutcome = {
      sourcePolicyId,
      answered: true,
      sourceUpdatedAt: probe.sourceUpdatedAt,
    };

    // RFC 0003 C1 (#440) — one narrative fact per match (incl.
    // `soft_reputation` / floor-ineligible). Raw indicator at
    // generation; the worker redacts at write.
    return {
      indicator,
      matches,
      facts: buildFactsFromMatches(indicator, matches),
      errors: [],
      outcomes: [outcome],
      checkedAt: "",
    };
  }
}

/**
 * Default Tier-1 source policies (RFC 0003 §"Source catalog"), derived from
 * the self-registering source registry (#588). All ship `floorEligible: false`
 * pending per-source licensing confirmation (Open Q#9) — they produce matches
 * for narrative/coverage but cannot drive the floor until cleared. Flipping one
 * to `true` once its terms are confirmed is a change to that source's
 * descriptor, requiring no code change here.
 *
 * Derived from the registry rather than declared inline so adding a source is
 * "add a descriptor file" with no edit to this array. Order is the registry's
 * deterministic stable-by-id ordering.
 */
export const LOCAL_FEED_POLICIES: readonly SourcePolicy[] =
  allTiSourceDescriptors().map((descriptor) => ({
    sourcePolicyId: descriptor.sourcePolicyId,
    label: descriptor.label,
    entityTypes: descriptor.entityTypes,
    deterministicCoverage: descriptor.deterministicCoverage,
    maxAge: descriptor.maxAge,
    floorEligible: descriptor.floorEligible,
  }));

/**
 * Wire a ready-to-use dispatcher backed by `store`: a registry of the
 * given policies (default `LOCAL_FEED_POLICIES`) plus one
 * `LocalFeedEnricher` per policy, each registered with the
 * `sourcePolicyId` it backs. Pass `now` for deterministic time in tests.
 */
export function buildLocalFeedDispatcher(
  store: FeedStore,
  options?: {
    now?: () => Date;
    policies?: readonly SourcePolicy[];
  },
): EnrichmentDispatcher {
  const policies = options?.policies ?? LOCAL_FEED_POLICIES;
  const registry = new SourcePolicyRegistry(policies);
  const dispatcher = new EnrichmentDispatcher({ registry, now: options?.now });
  for (const policy of policies) {
    dispatcher.register({
      enricher: new LocalFeedEnricher({
        policy,
        source: policy.sourcePolicyId,
        store,
      }),
      sourcePolicyIds: [policy.sourcePolicyId],
    });
  }
  return dispatcher;
}
