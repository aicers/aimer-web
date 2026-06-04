// RFC 0003 P1a (#361) — Tier-1 local-feed enricher + source policies.
//
// A DB-backed `Enricher` that matches a `NormalizedIndicator` against an
// imported feed snapshot (`ioc_feed_snapshot`, shared auth DB) and
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
import type { SourcePolicy } from "./source-policy";
import { SourcePolicyRegistry } from "./source-policy";
import type {
  Enricher,
  EnricherError,
  EnrichmentMatch,
  EnrichmentResult,
  EntityType,
  HitType,
  NormalizedIndicator,
  SourceOutcome,
} from "./types";

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
      sourceVersion: row.sourceVersion ?? probe.sourceVersion,
      feedHash: row.feedHash ?? probe.feedHash,
      sourceUpdatedAt: row.sourceUpdatedAt ?? probe.sourceUpdatedAt,
    }));

    const outcome: SourceOutcome = {
      sourcePolicyId,
      answered: true,
      sourceUpdatedAt: probe.sourceUpdatedAt,
    };

    // C1 fact injection is the separate #318 issue — P1a emits no facts.
    return {
      indicator,
      matches,
      facts: [],
      errors: [],
      outcomes: [outcome],
      checkedAt: "",
    };
  }
}

// Feed staleness bound: the Tier-1 feeds refresh roughly daily, so a
// snapshot older than two days is treated as stale (drives `stale`
// coverage). The feed-refresh worker that keeps these current is a
// separate RFC 0003 P1a follow-up.
const FEED_MAX_AGE_MS = 2 * 24 * 60 * 60 * 1000;

/**
 * Default Tier-1 source policies (RFC 0003 §"Source catalog"). All ship
 * `floorEligible: false` pending per-source licensing confirmation (Open
 * Q#9) — they produce matches for narrative/coverage but cannot drive the
 * floor until cleared. Flipping one to `true` once its terms are
 * confirmed is a config change here, requiring no code change elsewhere.
 */
export const LOCAL_FEED_POLICIES: readonly SourcePolicy[] = [
  {
    sourcePolicyId: "abuse.ch/feodo",
    label: "abuse.ch Feodo Tracker",
    entityTypes: ["IP"],
    deterministicCoverage: true,
    maxAge: FEED_MAX_AGE_MS,
    floorEligible: false,
  },
  {
    sourcePolicyId: "abuse.ch/urlhaus",
    label: "abuse.ch URLhaus",
    entityTypes: ["URL", "DOMAIN"],
    deterministicCoverage: true,
    maxAge: FEED_MAX_AGE_MS,
    floorEligible: false,
  },
  {
    sourcePolicyId: "abuse.ch/urlhaus-payloads",
    label: "abuse.ch URLhaus (payloads)",
    entityTypes: ["HASH"],
    deterministicCoverage: true,
    maxAge: FEED_MAX_AGE_MS,
    floorEligible: false,
  },
  {
    sourcePolicyId: "spamhaus/drop",
    label: "Spamhaus DROP",
    entityTypes: ["IP"],
    deterministicCoverage: true,
    maxAge: FEED_MAX_AGE_MS,
    floorEligible: false,
  },
  {
    sourcePolicyId: "spamhaus/edrop",
    label: "Spamhaus EDROP",
    entityTypes: ["IP"],
    deterministicCoverage: true,
    maxAge: FEED_MAX_AGE_MS,
    floorEligible: false,
  },
];

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
