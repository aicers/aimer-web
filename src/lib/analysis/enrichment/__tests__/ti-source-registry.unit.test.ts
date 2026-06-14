// RFC 0003 — composable self-registering TI source registry unit tests (#588).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import type { TiSourceDescriptor } from "../sources/registry";

/** A throwaway descriptor used to prove the "add a source = add a file" path. */
const FIXTURE_DESCRIPTOR: TiSourceDescriptor = {
  sourcePolicyId: "zzz-test/fixture",
  label: "Test Fixture Source",
  entityTypes: ["IP"],
  deterministicCoverage: true,
  maxAge: 1234,
  floorEligible: false,
  parse: "ip-blocklist",
  entityType: "IP",
  hitType: "deterministic_ioc",
  classification: "test",
  fetch: {
    urls: ["https://example.test/feed.txt"],
    cadenceFloorMs: 60_000,
    parse: "ip-blocklist",
  },
  fixtureFile: "test-fixture.txt",
};

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.resetModules();
});

describe("registerTiSource", () => {
  it("fails fast on a conflicting duplicate sourcePolicyId", async () => {
    const { registerTiSource } = await import("../sources/registry");
    registerTiSource({ ...FIXTURE_DESCRIPTOR });
    expect(() =>
      registerTiSource({ ...FIXTURE_DESCRIPTOR, label: "Conflicting" }),
    ).toThrow(/Duplicate TI source registration/);
  });

  it("is idempotent for a value-identical re-registration", async () => {
    const { registerTiSource, allTiSourceDescriptors } = await import(
      "../sources/registry"
    );
    registerTiSource({ ...FIXTURE_DESCRIPTOR });
    expect(() =>
      // A fresh-but-equal object (e.g. a module re-evaluated by the runner).
      registerTiSource({
        ...FIXTURE_DESCRIPTOR,
        entityTypes: ["IP"],
        fetch: {
          urls: ["https://example.test/feed.txt"],
          cadenceFloorMs: 60_000,
          parse: "ip-blocklist",
        },
      }),
    ).not.toThrow();
    expect(
      allTiSourceDescriptors().filter(
        (d) => d.sourcePolicyId === "zzz-test/fixture",
      ),
    ).toHaveLength(1);
  });

  it("returns descriptors in a deterministic stable-by-id order", async () => {
    const { registerTiSource, allTiSourceDescriptors } = await import(
      "../sources/registry"
    );
    // Register in scrambled order; accessor must sort by id regardless.
    for (const id of ["m/two", "a/one", "z/three", "a/last"]) {
      registerTiSource({ ...FIXTURE_DESCRIPTOR, sourcePolicyId: id });
    }
    expect(allTiSourceDescriptors().map((d) => d.sourcePolicyId)).toEqual([
      "a/last",
      "a/one",
      "m/two",
      "z/three",
    ]);
  });
});

describe("registerTiSource polarity invariants (#599)", () => {
  /** A valid negative (warninglist) descriptor: no hitType, no coverage/floor. */
  const NEGATIVE_DESCRIPTOR: TiSourceDescriptor = {
    sourcePolicyId: "zzz-test/warninglist",
    label: "Test Warninglist",
    polarity: "negative",
    entityTypes: ["IP"],
    deterministicCoverage: false,
    maxAge: 1234,
    floorEligible: false,
    parse: "ip-blocklist",
    entityType: "IP",
  };

  it("accepts a valid negative source (no hitType, no coverage/floor)", async () => {
    const { registerTiSource, getTiSourceDescriptor } = await import(
      "../sources/registry"
    );
    expect(() => registerTiSource({ ...NEGATIVE_DESCRIPTOR })).not.toThrow();
    expect(getTiSourceDescriptor("zzz-test/warninglist")?.polarity).toBe(
      "negative",
    );
  });

  it("rejects a negative source that declares a hitType", async () => {
    const { registerTiSource } = await import("../sources/registry");
    expect(() =>
      registerTiSource({
        ...NEGATIVE_DESCRIPTOR,
        hitType: "deterministic_ioc",
      }),
    ).toThrow(/must not declare a hitType/);
  });

  it("rejects a negative source with deterministicCoverage or floorEligible", async () => {
    const { registerTiSource } = await import("../sources/registry");
    expect(() =>
      registerTiSource({ ...NEGATIVE_DESCRIPTOR, deterministicCoverage: true }),
    ).toThrow(/deterministicCoverage:false and floorEligible:false/);
    expect(() =>
      registerTiSource({
        ...NEGATIVE_DESCRIPTOR,
        sourcePolicyId: "zzz-test/warninglist-2",
        floorEligible: true,
      }),
    ).toThrow(/deterministicCoverage:false and floorEligible:false/);
  });

  it("rejects a positive source that omits a hitType", async () => {
    const { registerTiSource } = await import("../sources/registry");
    expect(() =>
      registerTiSource({
        sourcePolicyId: "zzz-test/no-hittype",
        label: "Missing hitType",
        entityTypes: ["IP"],
        deterministicCoverage: true,
        maxAge: 1234,
        floorEligible: false,
        parse: "ip-blocklist",
        entityType: "IP",
      }),
    ).toThrow(/must declare a hitType/);
  });

  it("propagates negative polarity to the derived SourcePolicy", async () => {
    const { registerTiSource } = await import("../sources/registry");
    registerTiSource({ ...NEGATIVE_DESCRIPTOR });
    const { LOCAL_FEED_POLICIES } = await import("../local-feed-enricher");
    const policy = LOCAL_FEED_POLICIES.find(
      (p) => p.sourcePolicyId === "zzz-test/warninglist",
    );
    expect(policy?.polarity).toBe("negative");
  });
});

describe("a registered source is discoverable through every derived accessor", () => {
  it("appears in the policy list, catalog, fixture map, and parse dispatch", async () => {
    // Register the fixture BEFORE the deriving modules evaluate, so their
    // derived const arrays (computed at module load from the registry) include
    // it — demonstrating that adding a source needs no edit to any of them.
    const { registerTiSource, allTiSourceDescriptors } = await import(
      "../sources/registry"
    );
    registerTiSource({ ...FIXTURE_DESCRIPTOR });
    expect(allTiSourceDescriptors().map((d) => d.sourcePolicyId)).toContain(
      "zzz-test/fixture",
    );

    // Policy list (local-feed-enricher) — derived SourcePolicy.
    const { LOCAL_FEED_POLICIES } = await import("../local-feed-enricher");
    expect(
      LOCAL_FEED_POLICIES.find((p) => p.sourcePolicyId === "zzz-test/fixture"),
    ).toEqual({
      sourcePolicyId: "zzz-test/fixture",
      label: "Test Fixture Source",
      entityTypes: ["IP"],
      deterministicCoverage: true,
      maxAge: 1234,
      floorEligible: false,
    });

    // Catalog spec (feed-catalog) — derived Tier1FeedSource + lookup.
    const { TIER1_FEED_SOURCES, getTier1FeedSource } = await import(
      "../feed-catalog"
    );
    expect(
      TIER1_FEED_SOURCES.find((s) => s.sourcePolicyId === "zzz-test/fixture"),
    ).toEqual({
      sourcePolicyId: "zzz-test/fixture",
      label: "Test Fixture Source",
      parse: "ip-blocklist",
      entityType: "IP",
      hitType: "deterministic_ioc",
      classification: "test",
      maxAge: 1234,
      fetch: {
        urls: ["https://example.test/feed.txt"],
        cadenceFloorMs: 60_000,
        parse: "ip-blocklist",
      },
    });
    expect(getTier1FeedSource("zzz-test/fixture")?.classification).toBe("test");

    // Fixture map (fixture-feeds) — derived FixtureFeedSpec.
    const { FIXTURE_FEEDS } = await import("../fixture-feeds");
    expect(
      FIXTURE_FEEDS.find((f) => f.sourcePolicyId === "zzz-test/fixture")?.file,
    ).toBe("test-fixture.txt");

    // Parse dispatch (feed-import) — the descriptor's parse kind resolves.
    const { parseFeedContent } = await import("../feed-import");
    expect(
      parseFeedContent(
        FIXTURE_DESCRIPTOR.parse,
        FIXTURE_DESCRIPTOR.entityType,
        "1.2.3.4\n",
      ),
    ).toEqual([{ matchValue: "1.2.3.4" }]);
  });
});

describe("derived SourcePolicy[] regression for the registered sources", () => {
  it("matches the previous inline LOCAL_FEED_POLICIES exactly", async () => {
    // Fresh module graph: only the real source files register. Ordering follows
    // the registry's stable-by-id sort, so the four Botvrij policies and the
    // Infoblox policy and the three Phishing.Database policies fall between the
    // abuse.ch and Spamhaus groups.
    const { LOCAL_FEED_POLICIES } = await import("../local-feed-enricher");
    const FEED_MAX_AGE_MS = 2 * 24 * 60 * 60 * 1000;
    expect(LOCAL_FEED_POLICIES).toEqual([
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
        sourcePolicyId: "botvrij/domain",
        label: "Botvrij.eu (domain)",
        entityTypes: ["DOMAIN"],
        deterministicCoverage: true,
        maxAge: FEED_MAX_AGE_MS,
        floorEligible: false,
      },
      {
        sourcePolicyId: "botvrij/hash",
        label: "Botvrij.eu (hash)",
        entityTypes: ["HASH"],
        deterministicCoverage: true,
        maxAge: FEED_MAX_AGE_MS,
        floorEligible: false,
      },
      {
        sourcePolicyId: "botvrij/ip",
        label: "Botvrij.eu (IP)",
        entityTypes: ["IP"],
        deterministicCoverage: true,
        maxAge: FEED_MAX_AGE_MS,
        floorEligible: false,
      },
      {
        sourcePolicyId: "botvrij/url",
        label: "Botvrij.eu (URL)",
        entityTypes: ["URL"],
        deterministicCoverage: true,
        maxAge: FEED_MAX_AGE_MS,
        floorEligible: false,
      },
      {
        sourcePolicyId: "infoblox/threat-intelligence",
        label: "Infoblox Threat Intelligence (CC-BY-4.0)",
        entityTypes: ["DOMAIN", "IP", "URL", "HASH"],
        deterministicCoverage: true,
        maxAge: FEED_MAX_AGE_MS,
        floorEligible: false,
      },
      {
        sourcePolicyId: "phishing-database/domain",
        label: "Phishing.Database (domains)",
        entityTypes: ["DOMAIN"],
        deterministicCoverage: true,
        maxAge: FEED_MAX_AGE_MS,
        floorEligible: false,
      },
      {
        sourcePolicyId: "phishing-database/ip",
        label: "Phishing.Database (IPs)",
        entityTypes: ["IP"],
        deterministicCoverage: true,
        maxAge: FEED_MAX_AGE_MS,
        floorEligible: false,
      },
      {
        sourcePolicyId: "phishing-database/url",
        label: "Phishing.Database (URLs)",
        entityTypes: ["URL"],
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
    ]);
  });
});
