// RFC 0003 fan-out (#608) — Botvrij.eu source descriptors + fixtures.
//
// Botvrij registers four generic-list IOC sources (IP / domain / URL / hash)
// fetched from the bare `.raw` endpoints. These tests prove the descriptors are
// discoverable through every derived accessor, that each pinned `.raw`-style
// fixture parses to the expected normalized rows, and a hit/miss round-trip.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { getTier1FeedSource, TIER1_FEED_SOURCES } from "../feed-catalog";
import { parseFeedContent } from "../feed-import";
import { FIXTURE_FEEDS } from "../fixture-feeds";
import {
  buildLocalFeedDispatcher,
  type FeedMatchRow,
  type FeedSnapshotMeta,
  type FeedStore,
  LOCAL_FEED_POLICIES,
} from "../local-feed-enricher";
import {
  normalizeDomain,
  normalizeHash,
  normalizeIp,
  normalizeUrl,
} from "../normalization";
import "../sources";
import { getTiSourceDescriptor } from "../sources/registry";
import type { NormalizedIndicator } from "../types";

const FEEDS_DIR = join(
  process.cwd(),
  "src",
  "lib",
  "analysis",
  "enrichment",
  "feeds",
);
const fixture = (name: string): string =>
  readFileSync(join(FEEDS_DIR, name), "utf8");

const ONE_HOUR_MS = 60 * 60 * 1000;
const FEED_MAX_AGE_MS = 2 * 24 * 60 * 60 * 1000;

const BOTVRIJ_IDS = [
  "botvrij/domain",
  "botvrij/hash",
  "botvrij/ip",
  "botvrij/url",
] as const;

describe("Botvrij descriptors", () => {
  it("registers all four entity-type sources with the expected shape", () => {
    const ip = getTiSourceDescriptor("botvrij/ip");
    expect(ip).toMatchObject({
      label: "Botvrij.eu (IP)",
      entityTypes: ["IP"],
      entityType: "IP",
      deterministicCoverage: true,
      floorEligible: false,
      maxAge: FEED_MAX_AGE_MS,
      parse: "generic-list",
      parseConfig: { kind: "generic-list" },
      hitType: "deterministic_ioc",
      classification: "misc",
      fixtureFile: "botvrij-ip.txt",
    });
    expect(ip?.fetch).toEqual({
      urls: [
        "https://www.botvrij.eu/data/ioclist.ip-dst.raw",
        "https://www.botvrij.eu/data/ioclist.ip-src.raw",
      ],
      cadenceFloorMs: ONE_HOUR_MS,
      parse: "generic-list",
      parseConfig: { kind: "generic-list" },
    });
  });

  it("maps each entity type to its `.raw` endpoints (not the annotated files)", () => {
    expect(getTiSourceDescriptor("botvrij/domain")?.fetch?.urls).toEqual([
      "https://www.botvrij.eu/data/ioclist.domain.raw",
      "https://www.botvrij.eu/data/ioclist.hostname.raw",
    ]);
    expect(getTiSourceDescriptor("botvrij/url")?.fetch?.urls).toEqual([
      "https://www.botvrij.eu/data/ioclist.url.raw",
    ]);
    expect(getTiSourceDescriptor("botvrij/hash")?.fetch?.urls).toEqual([
      "https://www.botvrij.eu/data/ioclist.md5.raw",
      "https://www.botvrij.eu/data/ioclist.sha1.raw",
      "https://www.botvrij.eu/data/ioclist.sha256.raw",
    ]);
    // Every fetch URL is a `.raw` variant — never a bare annotated `ioclist.*`.
    for (const id of BOTVRIJ_IDS) {
      for (const url of getTiSourceDescriptor(id)?.fetch?.urls ?? []) {
        expect(url.endsWith(".raw")).toBe(true);
      }
    }
  });

  it("is discoverable through the catalog, policy list, and fixture map", () => {
    for (const id of BOTVRIJ_IDS) {
      expect(getTier1FeedSource(id)).toBeDefined();
      expect(
        TIER1_FEED_SOURCES.find((s) => s.sourcePolicyId === id),
      ).toBeDefined();
      expect(
        LOCAL_FEED_POLICIES.find((p) => p.sourcePolicyId === id),
      ).toBeDefined();
      expect(FIXTURE_FEEDS.find((f) => f.sourcePolicyId === id)).toBeDefined();
    }
  });
});

describe("Botvrij fixtures parse to the expected normalized rows", () => {
  it("parses the IP `.raw` fixture", () => {
    expect(
      parseFeedContent("generic-list", "IP", fixture("botvrij-ip.txt"), {
        kind: "generic-list",
      }),
    ).toEqual([
      { matchValue: "203.0.113.20" },
      { matchValue: "203.0.113.21" },
      { matchValue: "198.51.100.30" },
      { matchValue: "192.0.2.40" },
    ]);
  });

  it("parses the domain `.raw` fixture", () => {
    expect(
      parseFeedContent(
        "generic-list",
        "DOMAIN",
        fixture("botvrij-domain.txt"),
        {
          kind: "generic-list",
        },
      ),
    ).toEqual([
      { matchValue: "malware.example" },
      { matchValue: "c2.evil.example" },
      { matchValue: "bad-host.example" },
      { matchValue: "phishing.evil.example" },
    ]);
  });

  it("parses the URL `.raw` fixture", () => {
    expect(
      parseFeedContent("generic-list", "URL", fixture("botvrij-url.txt"), {
        kind: "generic-list",
      }),
    ).toEqual([
      { matchValue: "http://malware.example/a.exe" },
      { matchValue: "https://c2.evil.example/gate.php" },
      { matchValue: "http://phishing.evil.example/login" },
    ]);
  });

  it("parses the mixed MD5/SHA1/SHA256 hash `.raw` fixture", () => {
    expect(
      parseFeedContent("generic-list", "HASH", fixture("botvrij-hash.txt"), {
        kind: "generic-list",
      }),
    ).toEqual([
      { matchValue: "a".repeat(32) },
      { matchValue: "b".repeat(40) },
      { matchValue: "c".repeat(64) },
    ]);
  });
});

describe("Botvrij hit / miss", () => {
  const fresh = () => new Date("2026-06-04T12:00:00.000Z");
  const SOURCE_UPDATED = "2026-06-04T00:00:00.000Z";

  // In-memory store seeded with one Botvrij domain indicator.
  const store: FeedStore = {
    async probe(): Promise<FeedSnapshotMeta> {
      return { present: true, sourceUpdatedAt: SOURCE_UPDATED };
    },
    async match(
      sourcePolicyId: string,
      indicator: NormalizedIndicator,
    ): Promise<FeedMatchRow[]> {
      if (
        sourcePolicyId === "botvrij/domain" &&
        indicator.matchValues.includes("malware.example")
      ) {
        return [
          { hitType: "deterministic_ioc", sourceUpdatedAt: SOURCE_UPDATED },
        ];
      }
      return [];
    },
  };

  it("matches a seeded domain (hit) and misses an unknown one", async () => {
    const dispatcher = buildLocalFeedDispatcher(store, {
      now: fresh,
      policies: LOCAL_FEED_POLICIES.filter(
        (p) => p.sourcePolicyId === "botvrij/domain",
      ),
    });

    const hit = await dispatcher.dispatch(normalizeDomain("malware.example"));
    expect(hit.matches).toHaveLength(1);

    const miss = await dispatcher.dispatch(normalizeDomain("clean.example"));
    expect(miss.matches).toHaveLength(0);
  });

  it("exposes the other entity-type normalizers without error", () => {
    // Sanity: the fixture indicators normalize cleanly for each entity type.
    expect(normalizeIp("203.0.113.20").value).toBe("203.0.113.20");
    expect(normalizeUrl("http://malware.example/a.exe").value).toBe(
      "http://malware.example/a.exe",
    );
    expect(normalizeHash("a".repeat(32)).hashType).toBe("MD5");
  });
});
