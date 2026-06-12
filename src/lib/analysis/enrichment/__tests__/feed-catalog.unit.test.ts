// RFC 0003 Tier-1 feed-refresh (#566) — shared source catalog unit tests.

import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { getTier1FeedSource, TIER1_FEED_SOURCES } from "../feed-catalog";
import { LOCAL_FEED_POLICIES } from "../local-feed-enricher";

describe("TIER1_FEED_SOURCES", () => {
  it("covers exactly the five known Tier-1 sources, in order", () => {
    expect(TIER1_FEED_SOURCES.map((s) => s.sourcePolicyId)).toEqual([
      "abuse.ch/feodo",
      "abuse.ch/urlhaus",
      "abuse.ch/urlhaus-payloads",
      "spamhaus/drop",
      "spamhaus/edrop",
    ]);
  });

  it("sources label + maxAge from LOCAL_FEED_POLICIES (no drift)", () => {
    for (const source of TIER1_FEED_SOURCES) {
      const policy = LOCAL_FEED_POLICIES.find(
        (p) => p.sourcePolicyId === source.sourcePolicyId,
      );
      expect(policy).toBeDefined();
      expect(source.label).toBe(policy?.label);
      expect(source.maxAge).toBe(policy?.maxAge);
    }
  });

  it("getTier1FeedSource resolves known and rejects unknown sources", () => {
    expect(getTier1FeedSource("abuse.ch/feodo")?.parse).toBe("ip-blocklist");
    expect(getTier1FeedSource("bogus/source")).toBeUndefined();
  });
});

describe("FIXTURE_FEEDS derived from the catalog", () => {
  it("still produces the same five fixture specs (seeding unchanged)", async () => {
    const { FIXTURE_FEEDS } = await import("../fixture-feeds");

    expect(FIXTURE_FEEDS).toEqual([
      {
        sourcePolicyId: "abuse.ch/feodo",
        file: "feodo-ipblocklist.txt",
        parse: "ip-blocklist",
        entityType: "IP",
        hitType: "deterministic_ioc",
        classification: "c2",
      },
      {
        sourcePolicyId: "abuse.ch/urlhaus",
        file: "urlhaus.csv",
        parse: "urlhaus-csv",
        entityType: "URL",
        hitType: "deterministic_ioc",
        classification: "malware_url",
      },
      {
        sourcePolicyId: "abuse.ch/urlhaus-payloads",
        file: "urlhaus-payloads.csv",
        parse: "urlhaus-payloads-csv",
        entityType: "HASH",
        hitType: "deterministic_ioc",
        classification: "malware_payload",
      },
      {
        sourcePolicyId: "spamhaus/drop",
        file: "spamhaus-drop.txt",
        parse: "spamhaus-drop",
        entityType: "IP",
        hitType: "deterministic_ioc",
        classification: "drop",
      },
      {
        sourcePolicyId: "spamhaus/edrop",
        file: "spamhaus-edrop.txt",
        parse: "spamhaus-drop",
        entityType: "IP",
        hitType: "deterministic_ioc",
        classification: "edrop",
      },
    ]);
  });

  it("re-attaches each catalog source's parse fields onto its fixture spec", async () => {
    const { FIXTURE_FEEDS } = await import("../fixture-feeds");
    for (const source of TIER1_FEED_SOURCES) {
      const spec = FIXTURE_FEEDS.find(
        (f) => f.sourcePolicyId === source.sourcePolicyId,
      );
      expect(spec).toBeDefined();
      expect(spec?.parse).toBe(source.parse);
      expect(spec?.entityType).toBe(source.entityType);
      expect(spec?.hitType).toBe(source.hitType);
      expect(spec?.classification).toBe(source.classification);
    }
  });
});
