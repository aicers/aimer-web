// RFC 0003 P1a — fixture-backed reference enricher (issue §7).
//
// A trivial in-memory `Enricher` backed by a committed fixture (a pinned
// snapshot, never a live feed) that exercises the interface end-to-end:
// registration, `supports()`, dispatch + merge, both `hitType` values, clean
// no-hit answered outcomes, and (via the dispatcher) `coverageStatus`. This
// is the harness that proves the foundation works without real feeds — it is
// NOT the abuse.ch/Spamhaus adapter (that is the #361 follow-up).

import { EnrichmentDispatcher } from "./dispatcher";
import { createEnrichmentFact } from "./fact";
import fixtureFile from "./fixtures/reference-feeds.json";
import { ipInCidr } from "./normalization";
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

/** One fixture feed entry: matched by exact value or (IP only) CIDR. */
export interface FixtureEntry {
  /** Exact match against any of the indicator's match/derived values. */
  matchValue?: string;
  /** CIDR membership (IP indicators only). */
  cidr?: string;
  hitType: HitType;
  classification?: string;
  confidence?: number;
}

/** One pinned feed snapshot. */
export interface FixtureFeed {
  sourcePolicyId: string;
  source: string;
  entityTypes: EntityType[];
  sourceVersion?: string;
  feedHash?: string;
  /** Snapshot freshness; an old value drives `stale` coverage. */
  sourceUpdatedAt?: string;
  /** Absolute cache-TTL boundary echoed into the result. */
  expiresAt?: string;
  entries: FixtureEntry[];
}

export interface FixtureFile {
  feeds: FixtureFeed[];
}

/** Candidate strings an entry's `matchValue` may match against. */
function candidateValues(indicator: NormalizedIndicator): string[] {
  const values = [...indicator.matchValues];
  if (indicator.derived) {
    values.push(indicator.derived.url, indicator.derived.host);
    if (indicator.derived.registeredDomain) {
      values.push(indicator.derived.registeredDomain);
    }
  }
  return values;
}

function entryMatches(
  entry: FixtureEntry,
  indicator: NormalizedIndicator,
  candidates: string[],
): boolean {
  if (entry.cidr) {
    return (
      indicator.entityType === "IP" && ipInCidr(indicator.value, entry.cidr)
    );
  }
  if (entry.matchValue) {
    return candidates.includes(entry.matchValue);
  }
  return false;
}

/**
 * A fixture-backed enricher for exactly one feed. `floorEligible` on each
 * match is taken from the supplied source policy (NOT hardcoded); the
 * dispatcher applies the non-public IP override. Every `enrich` reports a
 * `SourceOutcome` — including a clean no-hit (`answered: true`, no matches) —
 * so coverage can tell an answered no-hit from a source that never ran.
 *
 * Set `failWith` to make the enricher throw, simulating an unavailable source
 * (the dispatcher then augments its outcome to `unavailable`).
 */
export class FixtureEnricher implements Enricher {
  private readonly feed: FixtureFeed;
  private readonly policy: SourcePolicy;
  private readonly failWith?: EnricherError;

  constructor(args: {
    feed: FixtureFeed;
    policy: SourcePolicy;
    failWith?: EnricherError;
  }) {
    this.feed = args.feed;
    this.policy = args.policy;
    this.failWith = args.failWith;
  }

  supports(entityType: EntityType): boolean {
    return this.feed.entityTypes.includes(entityType);
  }

  async enrich(indicator: NormalizedIndicator): Promise<EnrichmentResult> {
    if (this.failWith) {
      // Simulate a hard source failure: report the error and a non-answered
      // outcome so coverage marks it unavailable.
      const outcome: SourceOutcome = {
        sourcePolicyId: this.feed.sourcePolicyId,
        answered: false,
        error: this.failWith,
      };
      return {
        indicator,
        matches: [],
        facts: [],
        errors: [this.failWith],
        outcomes: [outcome],
        checkedAt: "",
      };
    }

    const candidates = candidateValues(indicator);
    const matches: EnrichmentMatch[] = [];
    const facts: EnrichmentResult["facts"] = [];
    for (const entry of this.feed.entries) {
      if (!entryMatches(entry, indicator, candidates)) continue;
      matches.push({
        source: this.feed.source,
        sourcePolicyId: this.feed.sourcePolicyId,
        hitType: entry.hitType,
        floorEligible: this.policy.floorEligible,
        classification: entry.classification,
        confidence: entry.confidence,
        sourceVersion: this.feed.sourceVersion,
        feedHash: this.feed.feedHash,
        sourceUpdatedAt: this.feed.sourceUpdatedAt,
      });
      facts.push(
        createEnrichmentFact(
          `${this.feed.source} lists ${indicator.value}` +
            (entry.classification ? ` as ${entry.classification}` : ""),
        ),
      );
    }

    // A responding source ALWAYS emits an answered outcome — including a
    // clean no-hit (matches: []).
    const outcome: SourceOutcome = {
      sourcePolicyId: this.feed.sourcePolicyId,
      answered: true,
      sourceUpdatedAt: this.feed.sourceUpdatedAt,
    };

    return {
      indicator,
      matches,
      facts,
      errors: [],
      outcomes: [outcome],
      checkedAt: "",
      expiresAt: this.feed.expiresAt,
    };
  }
}

/** The committed reference fixture, typed. */
export function loadReferenceFeeds(): FixtureFeed[] {
  return (fixtureFile as FixtureFile).feeds;
}

/**
 * Default source policies governing the reference feeds. The two abuse.ch
 * feeds are deterministic + floor-eligible; the internal reputation feed is
 * soft (not deterministic, not floor-eligible) so it never drives the floor.
 * `maxAge` is one day.
 */
export const REFERENCE_POLICIES: readonly SourcePolicy[] = [
  {
    sourcePolicyId: "abuse.ch/feodo",
    label: "abuse.ch Feodo Tracker",
    entityTypes: ["IP"],
    deterministicCoverage: true,
    maxAge: 24 * 60 * 60 * 1000,
    floorEligible: true,
  },
  {
    sourcePolicyId: "abuse.ch/urlhaus",
    label: "abuse.ch URLhaus",
    entityTypes: ["URL", "DOMAIN"],
    deterministicCoverage: true,
    maxAge: 24 * 60 * 60 * 1000,
    floorEligible: true,
  },
  {
    sourcePolicyId: "internal/reputation",
    label: "Internal reputation feed",
    entityTypes: ["IP", "DOMAIN"],
    deterministicCoverage: false,
    maxAge: 24 * 60 * 60 * 1000,
    floorEligible: false,
  },
];

/**
 * Wire the reference fixture into a ready-to-use dispatcher: a registry of
 * the default policies plus one `FixtureEnricher` per feed, each registered
 * with the `sourcePolicyId` it backs. Pass `now` for deterministic time, and
 * `failPolicyIds` to make those feeds' enrichers throw (simulating
 * unavailable sources).
 */
export function buildReferenceDispatcher(options?: {
  now?: () => Date;
  failPolicyIds?: readonly string[];
}): EnrichmentDispatcher {
  const policies = REFERENCE_POLICIES;
  const registry = new SourcePolicyRegistry(policies);
  const dispatcher = new EnrichmentDispatcher({ registry, now: options?.now });
  const fail = new Set(options?.failPolicyIds ?? []);
  for (const feed of loadReferenceFeeds()) {
    const policy = registry.get(feed.sourcePolicyId);
    if (!policy) continue;
    dispatcher.register({
      enricher: new FixtureEnricher({
        feed,
        policy,
        failWith: fail.has(feed.sourcePolicyId)
          ? {
              sourcePolicyId: feed.sourcePolicyId,
              kind: "unavailable",
              message: "simulated source failure",
            }
          : undefined,
      }),
      sourcePolicyIds: [feed.sourcePolicyId],
    });
  }
  return dispatcher;
}
