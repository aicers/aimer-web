// RFC 0003 F5 (#615) — MISP warninglists negative TI source.
//
// The first `polarity: "negative"` source: a known-good / known-noisy
// false-positive-suppression layer (public DNS resolvers, CDN/cloud ranges,
// bogons), never a known-bad feed. These tests prove the descriptor is a
// negative source discoverable through every derived accessor, that the bespoke
// `misp-warninglist` parser handles each branch (cidr / string / list-skip /
// entry-skip / malformed) and per-row classification, and that a warninglisted
// indicator drives a `NegativeMatch` — never a positive `EnrichmentMatch`.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { getTier1FeedSource, TIER1_FEED_SOURCES } from "../feed-catalog";
import {
  FeedParseError,
  parseFeedContent,
  parseMispWarninglists,
} from "../feed-import";
import { FIXTURE_FEEDS } from "../fixture-feeds";
import {
  buildLocalFeedDispatcher,
  type FeedMatchRow,
  type FeedSnapshotMeta,
  type FeedStore,
  LOCAL_FEED_POLICIES,
} from "../local-feed-enricher";
import { normalizeIp } from "../normalization";
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
const FEED_MAX_AGE_MS = 2 * 24 * 60 * 60 * 1000;

const RESOLVERS_LIST = "List of known IPv4 public DNS resolvers";
const CLOUDFLARE_LIST = "List of known Cloudflare IP ranges";

describe("MISP warninglists descriptor", () => {
  it("registers a single negative IP source with the expected shape", () => {
    expect(getTiSourceDescriptor("misp/warninglists")).toEqual({
      sourcePolicyId: "misp/warninglists",
      label: "MISP warninglists (CC0)",
      polarity: "negative",
      entityTypes: ["IP"],
      deterministicCoverage: false,
      maxAge: FEED_MAX_AGE_MS,
      floorEligible: false,
      parse: "misp-warninglist",
      entityType: "IP",
      fixtureFile: "misp-warninglists.json",
    });
  });

  it("carries no hitType and no self-fetch config (fixture-only)", () => {
    const descriptor = getTiSourceDescriptor("misp/warninglists");
    expect(descriptor?.hitType).toBeUndefined();
    expect(descriptor?.fetch).toBeUndefined();
  });

  it("is discoverable through the catalog, policy list, and fixture map", () => {
    expect(getTier1FeedSource("misp/warninglists")?.polarity).toBe("negative");
    expect(
      TIER1_FEED_SOURCES.find((s) => s.sourcePolicyId === "misp/warninglists"),
    ).toMatchObject({ polarity: "negative", hitType: undefined });
    expect(
      LOCAL_FEED_POLICIES.find((p) => p.sourcePolicyId === "misp/warninglists"),
    ).toMatchObject({ polarity: "negative", floorEligible: false });
    expect(
      FIXTURE_FEEDS.find((f) => f.sourcePolicyId === "misp/warninglists")?.file,
    ).toBe("misp-warninglists.json");
  });
});

describe("parseMispWarninglists branches", () => {
  it("emits cidr rows for a `cidr` list (canonicalized, host bits zeroed)", () => {
    const rows = parseMispWarninglists(
      JSON.stringify([
        {
          name: CLOUDFLARE_LIST,
          type: "cidr",
          list: ["103.21.244.0/22", "192.0.2.0/24"],
        },
      ]),
    );
    expect(rows).toEqual([
      { cidr: "103.21.244.0/22", classification: CLOUDFLARE_LIST },
      { cidr: "192.0.2.0/24", classification: CLOUDFLARE_LIST },
    ]);
  });

  it("emits exact IP matchValue rows for `string` and `hostname` IP lists", () => {
    const fromString = parseMispWarninglists(
      JSON.stringify([
        { name: RESOLVERS_LIST, type: "string", list: ["1.1.1.1", "8.8.8.8"] },
      ]),
    );
    expect(fromString).toEqual([
      { matchValue: "1.1.1.1", classification: RESOLVERS_LIST },
      { matchValue: "8.8.8.8", classification: RESOLVERS_LIST },
    ]);
    // `hostname` is treated identically (v1 imports only its IP-valued entries).
    const fromHostname = parseMispWarninglists(
      JSON.stringify([{ name: "h", type: "hostname", list: ["9.9.9.9"] }]),
    );
    expect(fromHostname).toEqual([
      { matchValue: "9.9.9.9", classification: "h" },
    ]);
  });

  it("skips a whole `substring` / `regex` / unknown-type list silently", () => {
    const rows = parseMispWarninglists(
      JSON.stringify([
        { name: "subs", type: "substring", list: ["example.com"] },
        { name: "re", type: "regex", list: ["^evil"] },
        { name: "future", type: "newfangled", list: ["1.2.3.4"] },
      ]),
    );
    expect(rows).toEqual([]);
  });

  it("skips a non-IP entry inside a supported list (v1 is IP-only)", () => {
    const rows = parseMispWarninglists(
      JSON.stringify([
        {
          name: RESOLVERS_LIST,
          type: "string",
          list: ["1.1.1.1", "resolver.example.test", "8.8.8.8"],
        },
      ]),
    );
    expect(rows).toEqual([
      { matchValue: "1.1.1.1", classification: RESOLVERS_LIST },
      { matchValue: "8.8.8.8", classification: RESOLVERS_LIST },
    ]);
  });

  it("flattens multiple lists into one row set, each row keeping its list name", () => {
    const rows = parseMispWarninglists(
      JSON.stringify([
        { name: RESOLVERS_LIST, type: "string", list: ["1.1.1.1"] },
        { name: CLOUDFLARE_LIST, type: "cidr", list: ["103.21.244.0/22"] },
        { name: "skipme", type: "substring", list: ["example.com"] },
      ]),
    );
    expect(rows).toEqual([
      { matchValue: "1.1.1.1", classification: RESOLVERS_LIST },
      { cidr: "103.21.244.0/22", classification: CLOUDFLARE_LIST },
    ]);
  });

  it("omits classification when a list has no name", () => {
    const rows = parseMispWarninglists(
      JSON.stringify([{ type: "string", list: ["1.1.1.1"] }]),
    );
    expect(rows).toEqual([{ matchValue: "1.1.1.1" }]);
  });

  it("raises FeedParseError on malformed input (never a silent skip)", () => {
    expect(() => parseMispWarninglists("{not json")).toThrow(FeedParseError);
    // Top-level value not an array.
    expect(() =>
      parseMispWarninglists(JSON.stringify({ type: "string", list: [] })),
    ).toThrow(FeedParseError);
    // A list element that is not an object.
    expect(() => parseMispWarninglists(JSON.stringify(["x"]))).toThrow(
      FeedParseError,
    );
    // A list element missing `type`.
    expect(() =>
      parseMispWarninglists(JSON.stringify([{ list: ["1.1.1.1"] }])),
    ).toThrow(FeedParseError);
    // A list element whose `list` is not an array.
    expect(() =>
      parseMispWarninglists(JSON.stringify([{ type: "string", list: "nope" }])),
    ).toThrow(FeedParseError);
  });
});

describe("misp-warninglist via parseFeedContent + pinned fixture", () => {
  it("dispatches to the bespoke parser", () => {
    const content = JSON.stringify([
      { name: RESOLVERS_LIST, type: "string", list: ["1.1.1.1"] },
    ]);
    expect(parseFeedContent("misp-warninglist", "IP", content)).toEqual([
      { matchValue: "1.1.1.1", classification: RESOLVERS_LIST },
    ]);
  });

  it("parses the committed fixture into the expected normalized rows", () => {
    const content = readFileSync(
      join(FEEDS_DIR, "misp-warninglists.json"),
      "utf8",
    );
    expect(parseFeedContent("misp-warninglist", "IP", content)).toEqual([
      { matchValue: "1.1.1.1", classification: RESOLVERS_LIST },
      { matchValue: "8.8.8.8", classification: RESOLVERS_LIST },
      { matchValue: "9.9.9.9", classification: RESOLVERS_LIST },
      { cidr: "103.21.244.0/22", classification: CLOUDFLARE_LIST },
      { cidr: "192.0.2.0/24", classification: CLOUDFLARE_LIST },
    ]);
  });
});

describe("MISP warninglists hit drives a NegativeMatch, never a positive match", () => {
  const fresh = () => new Date("2026-06-04T12:00:00.000Z");
  const SOURCE_UPDATED = "2026-06-04T00:00:00.000Z";

  // In-memory store: a warninglisted IP returns a row with NO hitType (a
  // negative row carries NULL `hit_type`) but a per-list classification.
  const store: FeedStore = {
    async probe(): Promise<FeedSnapshotMeta> {
      return { present: true, sourceUpdatedAt: SOURCE_UPDATED };
    },
    async match(
      sourcePolicyId: string,
      indicator: NormalizedIndicator,
    ): Promise<FeedMatchRow[]> {
      if (sourcePolicyId !== "misp/warninglists") return [];
      if (indicator.value === "1.1.1.1") {
        return [
          { classification: RESOLVERS_LIST, sourceUpdatedAt: SOURCE_UPDATED },
        ];
      }
      return [];
    },
  };

  const dispatcher = () =>
    buildLocalFeedDispatcher(store, {
      now: fresh,
      policies: LOCAL_FEED_POLICIES.filter(
        (p) => p.sourcePolicyId === "misp/warninglists",
      ),
    });

  it("surfaces a hit as a NegativeMatch carrying the warninglist name", async () => {
    const result = await dispatcher().dispatch(normalizeIp("1.1.1.1"));
    // Never a positive match — a negative source can never set known_ioc_hit.
    expect(result.matches).toHaveLength(0);
    expect(result.negativeMatches).toHaveLength(1);
    expect(result.negativeMatches?.[0]).toMatchObject({
      sourcePolicyId: "misp/warninglists",
      classification: RESOLVERS_LIST,
    });
    // A negative match carries no hitType / floorEligible (the type omits them).
    expect("hitType" in (result.negativeMatches?.[0] ?? {})).toBe(false);
    expect("floorEligible" in (result.negativeMatches?.[0] ?? {})).toBe(false);
    expect(result.facts).toHaveLength(0);
  });

  it("misses an indicator that is not warninglisted", async () => {
    const result = await dispatcher().dispatch(normalizeIp("203.0.113.9"));
    expect(result.matches).toHaveLength(0);
    expect(result.negativeMatches ?? []).toHaveLength(0);
  });
});
