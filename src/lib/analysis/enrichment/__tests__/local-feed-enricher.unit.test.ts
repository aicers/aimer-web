// RFC 0003 P1a (#361) — local-feed enricher source-match + hit-type /
// floor-eligibility / coverage tests, driven by an in-memory `FeedStore`
// (no DB). Mirrors the RFC 0003 §"Testing" matrix.

import { describe, expect, it } from "vitest";
import {
  buildFactsFromMatches,
  buildLocalFeedDispatcher,
  type FeedMatchRow,
  type FeedSnapshotMeta,
  type FeedStore,
} from "../local-feed-enricher";
import {
  normalizeDomain,
  normalizeHash,
  normalizeIp,
  normalizeUrl,
} from "../normalization";
import type { SourcePolicy } from "../source-policy";
import { matchSatisfiesFloor } from "../source-policy";
import type { NormalizedIndicator } from "../types";

const SOURCE_UPDATED = "2026-06-04T00:00:00.000Z";
const fresh = () => new Date("2026-06-04T12:00:00.000Z");
// Past every feed's 2-day maxAge.
const stale = () => new Date("2026-06-10T00:00:00.000Z");

// A single floor-eligible deterministic IP feed for the focused cases.
const FEODO_FLOORING: SourcePolicy[] = [
  {
    sourcePolicyId: "abuse.ch/feodo",
    label: "abuse.ch Feodo Tracker",
    entityTypes: ["IP"],
    deterministicCoverage: true,
    maxAge: 2 * 24 * 60 * 60 * 1000,
    floorEligible: true,
  },
];

/**
 * In-memory feed store. `data` maps sourcePolicyId → exact match values;
 * `cidrs` maps sourcePolicyId → CIDR ranges; `meta` overrides per-source
 * snapshot metadata (absent → a fresh present snapshot; `null` → missing).
 */
class FakeFeedStore implements FeedStore {
  constructor(
    private readonly opts: {
      exact?: Record<string, string[]>;
      cidrs?: Record<string, string[]>;
      meta?: Record<string, FeedSnapshotMeta | null>;
      hitType?: "deterministic_ioc" | "soft_reputation";
    },
  ) {}

  async probe(sourcePolicyId: string): Promise<FeedSnapshotMeta> {
    const override = this.opts.meta?.[sourcePolicyId];
    if (override === null) return { present: false };
    if (override) return override;
    return { present: true, sourceUpdatedAt: SOURCE_UPDATED };
  }

  async match(
    sourcePolicyId: string,
    indicator: NormalizedIndicator,
  ): Promise<FeedMatchRow[]> {
    const hitType = this.opts.hitType ?? "deterministic_ioc";
    const out: FeedMatchRow[] = [];
    const candidates = new Set<string>([...indicator.matchValues]);
    if (indicator.derived) {
      candidates.add(indicator.derived.url);
      candidates.add(indicator.derived.host);
      if (indicator.derived.registeredDomain) {
        candidates.add(indicator.derived.registeredDomain);
      }
    }
    for (const value of this.opts.exact?.[sourcePolicyId] ?? []) {
      if (candidates.has(value)) {
        out.push({ hitType, sourceUpdatedAt: SOURCE_UPDATED });
      }
    }
    for (const cidr of this.opts.cidrs?.[sourcePolicyId] ?? []) {
      if (indicator.entityType === "IP" && inCidr(indicator.value, cidr)) {
        out.push({ hitType, sourceUpdatedAt: SOURCE_UPDATED });
      }
    }
    return out;
  }
}

// Tiny IPv4 CIDR test used only by the fake store.
function inCidr(ip: string, cidr: string): boolean {
  const [net, bitsRaw] = cidr.split("/");
  const bits = Number(bitsRaw);
  const toInt = (s: string) =>
    s.split(".").reduce((acc, o) => (acc << 8) + Number(o), 0) >>> 0;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (toInt(ip) & mask) === (toInt(net) & mask);
}

describe("local-feed enricher — source match per entity type", () => {
  it("matches a known IP by exact value (hit) and misses an unknown IP", async () => {
    const store = new FakeFeedStore({
      exact: { "abuse.ch/feodo": ["45.66.230.5"] },
    });
    const dispatcher = buildLocalFeedDispatcher(store, {
      now: fresh,
      policies: FEODO_FLOORING,
    });

    const hit = await dispatcher.dispatch(normalizeIp("45.66.230.5"));
    expect(hit.matches.some(matchSatisfiesFloor)).toBe(true);
    expect(hit.coverage.status).toBe("complete");

    const miss = await dispatcher.dispatch(normalizeIp("45.66.230.99"));
    expect(miss.matches).toHaveLength(0);
    // A clean answered no-hit is still complete coverage, not unknown.
    expect(miss.coverage.status).toBe("complete");
  });

  it("matches an IP inside a CIDR range entry", async () => {
    const store = new FakeFeedStore({
      cidrs: { "abuse.ch/feodo": ["45.66.230.0/24"] },
    });
    const dispatcher = buildLocalFeedDispatcher(store, {
      now: fresh,
      policies: FEODO_FLOORING,
    });
    const hit = await dispatcher.dispatch(normalizeIp("45.66.230.77"));
    expect(hit.matches.some(matchSatisfiesFloor)).toBe(true);
  });

  it("matches a URL, its host, and registered domain via derived candidates", async () => {
    const urlPolicy: SourcePolicy[] = [
      {
        sourcePolicyId: "abuse.ch/urlhaus",
        label: "abuse.ch URLhaus",
        entityTypes: ["URL", "DOMAIN"],
        deterministicCoverage: true,
        maxAge: 2 * 24 * 60 * 60 * 1000,
        floorEligible: true,
      },
    ];
    const store = new FakeFeedStore({
      exact: { "abuse.ch/urlhaus": ["http://malware.example/payload.exe"] },
    });
    const dispatcher = buildLocalFeedDispatcher(store, {
      now: fresh,
      policies: urlPolicy,
    });
    const hit = await dispatcher.dispatch(
      normalizeUrl("http://malware.example/payload.exe"),
    );
    expect(hit.matches.some(matchSatisfiesFloor)).toBe(true);
  });

  it("matches a file hash by exact lowercased digest", async () => {
    const sha = "a".repeat(64);
    // The shipped URLhaus payloads source (a Tier-1 feed that publishes a
    // Collected Payloads dump keyed by MD5/SHA-256), made floor-eligible here
    // to exercise the floor path — it ships `floorEligible: false`.
    const hashPolicy: SourcePolicy[] = [
      {
        sourcePolicyId: "abuse.ch/urlhaus-payloads",
        label: "abuse.ch URLhaus (payloads)",
        entityTypes: ["HASH"],
        deterministicCoverage: true,
        maxAge: 2 * 24 * 60 * 60 * 1000,
        floorEligible: true,
      },
    ];
    const store = new FakeFeedStore({
      exact: { "abuse.ch/urlhaus-payloads": [sha] },
    });
    const dispatcher = buildLocalFeedDispatcher(store, {
      now: fresh,
      policies: hashPolicy,
    });
    const hit = await dispatcher.dispatch(normalizeHash(sha.toUpperCase()));
    expect(hit.matches.some(matchSatisfiesFloor)).toBe(true);
  });

  it("the shipped policies answer the HASH entity type (URLhaus payloads)", async () => {
    // A hash IOC must be answerable by a shipped Tier-1 source, not only by a
    // synthetic test policy — and it stays floor-ineligible under the
    // licensing gate.
    const sha = "b".repeat(64);
    const store = new FakeFeedStore({
      exact: { "abuse.ch/urlhaus-payloads": [sha] },
    });
    const dispatcher = buildLocalFeedDispatcher(store, { now: fresh });
    const result = await dispatcher.dispatch(normalizeHash(sha));
    expect(result.matches.length).toBeGreaterThan(0);
    expect(result.matches.some(matchSatisfiesFloor)).toBe(false);
    expect(result.coverage.status).toBe("complete");
  });
});

describe("local-feed enricher — hit-type / floor-eligibility", () => {
  it("a soft_reputation match never sets the floor", async () => {
    const store = new FakeFeedStore({
      exact: { "abuse.ch/feodo": ["45.66.230.5"] },
      hitType: "soft_reputation",
    });
    const dispatcher = buildLocalFeedDispatcher(store, {
      now: fresh,
      policies: FEODO_FLOORING,
    });
    const result = await dispatcher.dispatch(normalizeIp("45.66.230.5"));
    expect(result.matches).toHaveLength(1);
    expect(result.matches.some(matchSatisfiesFloor)).toBe(false);
  });

  it("a deterministic match from a floorEligible:false source does not set the floor", async () => {
    const notEligible: SourcePolicy[] = [
      { ...FEODO_FLOORING[0], floorEligible: false },
    ];
    const store = new FakeFeedStore({
      exact: { "abuse.ch/feodo": ["45.66.230.5"] },
    });
    const dispatcher = buildLocalFeedDispatcher(store, {
      now: fresh,
      policies: notEligible,
    });
    const result = await dispatcher.dispatch(normalizeIp("45.66.230.5"));
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0].hitType).toBe("deterministic_ioc");
    expect(result.matches.some(matchSatisfiesFloor)).toBe(false);
  });

  it("the default LOCAL_FEED_POLICIES are all floorEligible:false (licensing gate)", async () => {
    // A floor-eligible deterministic match against the SHIPPED policies must
    // not exist until a feed's terms are confirmed.
    const store = new FakeFeedStore({
      exact: { "abuse.ch/feodo": ["45.66.230.5"] },
    });
    const dispatcher = buildLocalFeedDispatcher(store, { now: fresh });
    const result = await dispatcher.dispatch(normalizeIp("45.66.230.5"));
    expect(result.matches.length).toBeGreaterThan(0);
    expect(result.matches.some(matchSatisfiesFloor)).toBe(false);
  });

  it("a non-public IP is never floor-eligible even on a floorEligible source", async () => {
    const store = new FakeFeedStore({
      cidrs: { "abuse.ch/feodo": ["10.0.0.0/8"] },
    });
    const dispatcher = buildLocalFeedDispatcher(store, {
      now: fresh,
      policies: FEODO_FLOORING,
    });
    const result = await dispatcher.dispatch(normalizeIp("10.1.2.3"));
    expect(result.matches).toHaveLength(1);
    // The match exists but the dispatcher's non-public-IP override forces
    // floorEligible:false.
    expect(result.matches[0].floorEligible).toBe(false);
    expect(result.matches.some(matchSatisfiesFloor)).toBe(false);
  });
});

describe("local-feed enricher — coverage / staleness", () => {
  it("a stale snapshot yields stale coverage (not a silent false)", async () => {
    const store = new FakeFeedStore({
      exact: { "abuse.ch/feodo": ["45.66.230.5"] },
    });
    const dispatcher = buildLocalFeedDispatcher(store, {
      now: stale,
      policies: FEODO_FLOORING,
    });
    const result = await dispatcher.dispatch(normalizeIp("45.66.230.99"));
    expect(result.matches).toHaveLength(0);
    expect(result.coverage.status).toBe("stale");
  });

  it("a missing snapshot yields unknown coverage (not a silent false)", async () => {
    const store = new FakeFeedStore({
      meta: { "abuse.ch/feodo": null },
    });
    const dispatcher = buildLocalFeedDispatcher(store, {
      now: fresh,
      policies: FEODO_FLOORING,
    });
    const result = await dispatcher.dispatch(normalizeIp("45.66.230.99"));
    expect(result.matches).toHaveLength(0);
    expect(result.coverage.status).toBe("unknown");
  });

  it("a stale source still reports a floor hit it observed (boolean monotonic)", async () => {
    const store = new FakeFeedStore({
      exact: { "abuse.ch/feodo": ["45.66.230.5"] },
    });
    const dispatcher = buildLocalFeedDispatcher(store, {
      now: stale,
      policies: FEODO_FLOORING,
    });
    const result = await dispatcher.dispatch(normalizeIp("45.66.230.5"));
    // The hit stands even though coverage is downgraded to stale.
    expect(result.matches.some(matchSatisfiesFloor)).toBe(true);
    expect(result.coverage.status).toBe("stale");
  });

  it("an allowlisted (non-listed) domain produces no match (fact-free)", async () => {
    const urlPolicy: SourcePolicy[] = [
      {
        sourcePolicyId: "abuse.ch/urlhaus",
        label: "abuse.ch URLhaus",
        entityTypes: ["URL", "DOMAIN"],
        deterministicCoverage: true,
        maxAge: 2 * 24 * 60 * 60 * 1000,
        floorEligible: true,
      },
    ];
    const store = new FakeFeedStore({
      exact: { "abuse.ch/urlhaus": ["malware.example"] },
    });
    const dispatcher = buildLocalFeedDispatcher(store, {
      now: fresh,
      policies: urlPolicy,
    });
    const result = await dispatcher.dispatch(normalizeDomain("good.example"));
    expect(result.matches).toHaveLength(0);
    expect(result.coverage.status).toBe("complete");
    // No match → no fact.
    expect(result.facts).toHaveLength(0);
  });
});

describe("local-feed enricher — fact generation (#440)", () => {
  it("emits one narrative fact per match, carrying the raw indicator", async () => {
    const store = new FakeFeedStore({
      exact: { "abuse.ch/feodo": ["45.66.230.5"] },
    });
    const dispatcher = buildLocalFeedDispatcher(store, {
      now: fresh,
      policies: FEODO_FLOORING,
    });
    const result = await dispatcher.dispatch(normalizeIp("45.66.230.5"));
    expect(result.matches).toHaveLength(1);
    expect(result.facts).toHaveLength(1);
    // Raw indicator value at generation (redaction happens later, at write).
    expect(result.facts[0].text).toContain("45.66.230.5");
    expect(result.facts[0].text).toContain("abuse.ch/feodo");
    expect(result.facts[0].redactionTokens).toEqual([]);
  });

  it("generates a fact for a soft_reputation / floor-ineligible match too", async () => {
    const store = new FakeFeedStore({
      exact: { "abuse.ch/feodo": ["45.66.230.5"] },
      hitType: "soft_reputation",
    });
    const dispatcher = buildLocalFeedDispatcher(store, {
      now: fresh,
      policies: FEODO_FLOORING,
    });
    const result = await dispatcher.dispatch(normalizeIp("45.66.230.5"));
    // Never drives the floor, but still narrates.
    expect(result.matches.some(matchSatisfiesFloor)).toBe(false);
    expect(result.facts).toHaveLength(1);
    expect(result.facts[0].text).toContain("45.66.230.5");
  });

  it("emits no facts when there is no match", async () => {
    const store = new FakeFeedStore({
      exact: { "abuse.ch/feodo": ["45.66.230.5"] },
    });
    const dispatcher = buildLocalFeedDispatcher(store, {
      now: fresh,
      policies: FEODO_FLOORING,
    });
    const result = await dispatcher.dispatch(normalizeIp("45.66.230.99"));
    expect(result.facts).toHaveLength(0);
  });

  it("buildFactsFromMatches appends the classification when present", () => {
    const facts = buildFactsFromMatches(normalizeDomain("malware.example"), [
      {
        source: "abuse.ch/urlhaus",
        sourcePolicyId: "abuse.ch/urlhaus",
        hitType: "deterministic_ioc",
        floorEligible: false,
        classification: "malware_download",
      },
      {
        source: "abuse.ch/urlhaus",
        sourcePolicyId: "abuse.ch/urlhaus",
        hitType: "deterministic_ioc",
        floorEligible: false,
      },
    ]);
    expect(facts).toHaveLength(2);
    expect(facts[0].text).toBe(
      "malware.example is listed by abuse.ch/urlhaus as malware_download",
    );
    // No classification → no trailing "as ...".
    expect(facts[1].text).toBe("malware.example is listed by abuse.ch/urlhaus");
  });
});
