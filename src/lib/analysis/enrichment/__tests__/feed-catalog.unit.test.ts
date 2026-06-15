// RFC 0003 Tier-1 feed-refresh (#566) — shared source catalog unit tests.

import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { getTier1FeedSource, TIER1_FEED_SOURCES } from "../feed-catalog";
import { LOCAL_FEED_POLICIES } from "../local-feed-enricher";

describe("TIER1_FEED_SOURCES", () => {
  it("covers exactly the known Tier-1 sources, in stable-by-id order", () => {
    expect(TIER1_FEED_SOURCES.map((s) => s.sourcePolicyId)).toEqual([
      "abuse.ch/feodo",
      "abuse.ch/urlhaus",
      "abuse.ch/urlhaus-payloads",
      "botvrij/domain",
      "botvrij/hash",
      "botvrij/ip",
      "botvrij/url",
      "eset/malware-ioc",
      "infoblox/threat-intelligence",
      "misp/warninglists",
      "phishing-database/domain",
      "phishing-database/ip",
      "phishing-database/url",
      "spamhaus/drop",
      "spamhaus/edrop",
      "unit42/threat-intel",
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
  it("still produces the expected fixture specs (seeding unchanged)", async () => {
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
        sourcePolicyId: "botvrij/domain",
        file: "botvrij-domain.txt",
        parse: "generic-list",
        parseConfig: { kind: "generic-list" },
        entityType: "DOMAIN",
        hitType: "deterministic_ioc",
        classification: "misc",
      },
      {
        sourcePolicyId: "botvrij/hash",
        file: "botvrij-hash.txt",
        parse: "generic-list",
        parseConfig: { kind: "generic-list" },
        entityType: "HASH",
        hitType: "deterministic_ioc",
        classification: "misc",
      },
      {
        sourcePolicyId: "botvrij/ip",
        file: "botvrij-ip.txt",
        parse: "generic-list",
        parseConfig: { kind: "generic-list" },
        entityType: "IP",
        hitType: "deterministic_ioc",
        classification: "misc",
      },
      {
        sourcePolicyId: "botvrij/url",
        file: "botvrij-url.txt",
        parse: "generic-list",
        parseConfig: { kind: "generic-list" },
        entityType: "URL",
        hitType: "deterministic_ioc",
        classification: "misc",
      },
      {
        sourcePolicyId: "infoblox/threat-intelligence",
        file: "infoblox-threat-intelligence.csv",
        parse: "csv-column",
        parseConfig: {
          kind: "csv-column",
          typeColumn: {
            value: { name: "indicator" },
            type: { name: "type" },
            typeMap: {
              domain: "DOMAIN",
              ip: "IP",
              ipv4: "IP",
              url: "URL",
              sha256: "HASH",
            },
          },
          rowFilter: {
            column: { name: "classification" },
            allow: [
              "malicious",
              "suspicious",
              "malware",
              "phishing",
              "smishing",
              "scam",
              "spam",
              "malvertising",
              "redirect",
              "monetizer",
              "rexpush",
              "bropush",
              "richads",
              "help_tds",
              "partners_house",
              "ddga",
              "propaganda",
              "vextrio",
              "vextrio_affiliate",
              "vextrio_dns_c2_set1",
              "vextrio_dns_c2_set2",
              "vextrio_dns_txt_redirect",
            ],
          },
          refang: true,
          skipHeader: true,
        },
        entityType: "DOMAIN",
        hitType: "deterministic_ioc",
        classification: "infoblox",
      },
      {
        sourcePolicyId: "misp/warninglists",
        file: "misp-warninglists.json",
        parse: "misp-warninglist",
        entityType: "IP",
        polarity: "negative",
      },
      {
        sourcePolicyId: "phishing-database/domain",
        file: "phishing-database-domains.txt",
        parse: "generic-list",
        entityType: "DOMAIN",
        hitType: "deterministic_ioc",
        classification: "phishing",
      },
      {
        sourcePolicyId: "phishing-database/ip",
        file: "phishing-database-ips.txt",
        parse: "generic-list",
        entityType: "IP",
        hitType: "deterministic_ioc",
        classification: "phishing",
      },
      {
        sourcePolicyId: "phishing-database/url",
        file: "phishing-database-urls.txt",
        parse: "generic-list",
        entityType: "URL",
        hitType: "deterministic_ioc",
        classification: "phishing",
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
    // A vendor-repo source (unit42/threat-intel) declares a `fixtureDir`, not a
    // flat `fixtureFile`, so it is intentionally absent from FIXTURE_FEEDS — its
    // tree is seeded by the vendor-repo engine, not the flat fixture path.
    for (const source of TIER1_FEED_SOURCES.filter((s) => !s.vendorRepo)) {
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
