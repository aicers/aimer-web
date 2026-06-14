// RFC 0003 fan-out (#606) — Phishing.Database source descriptors + fixtures.
//
// Verifies the three self-registered descriptors (domain / URL / IP), that each
// pinned fixture parses to its expected normalized rows via the shared
// `generic-list` parser (no bespoke parser), and a hit/miss against each list.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { parseFeedContent } from "../feed-import";
import "../sources";
import { getTiSourceDescriptor } from "../sources/registry";

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

describe("Phishing.Database descriptors (#606)", () => {
  it("registers domain, url, and ip descriptors with the expected shape", () => {
    const expected = [
      {
        id: "phishing-database/domain",
        label: "Phishing.Database (domains)",
        entityType: "DOMAIN" as const,
        fixtureFile: "phishing-database-domains.txt",
        url: "https://raw.githubusercontent.com/Phishing-Database/Phishing.Database/master/phishing-domains-ACTIVE.txt",
      },
      {
        id: "phishing-database/url",
        label: "Phishing.Database (URLs)",
        entityType: "URL" as const,
        fixtureFile: "phishing-database-urls.txt",
        url: "https://raw.githubusercontent.com/Phishing-Database/Phishing.Database/master/phishing-links-ACTIVE.txt",
      },
      {
        id: "phishing-database/ip",
        label: "Phishing.Database (IPs)",
        entityType: "IP" as const,
        fixtureFile: "phishing-database-ips.txt",
        url: "https://raw.githubusercontent.com/Phishing-Database/Phishing.Database/master/phishing-IPs-ACTIVE.txt",
      },
    ];

    for (const e of expected) {
      const d = getTiSourceDescriptor(e.id);
      expect(d).toBeDefined();
      expect(d?.label).toBe(e.label);
      expect(d?.entityType).toBe(e.entityType);
      expect(d?.entityTypes).toEqual([e.entityType]);
      expect(d?.parse).toBe("generic-list");
      expect(d?.parseConfig).toBeUndefined();
      expect(d?.hitType).toBe("deterministic_ioc");
      expect(d?.classification).toBe("phishing");
      expect(d?.deterministicCoverage).toBe(true);
      expect(d?.floorEligible).toBe(false);
      expect(d?.fixtureFile).toBe(e.fixtureFile);
      // Self-fetch: 1 h floor over raw.githubusercontent.com, no Auth-Key.
      expect(d?.fetch?.urls).toEqual([e.url]);
      expect(d?.fetch?.cadenceFloorMs).toBe(60 * 60 * 1000);
      expect(d?.fetch?.parse).toBe("generic-list");
      expect(d?.fetch?.authKeyName).toBeUndefined();
      expect(d?.fetch?.parseConfig).toBeUndefined();
    }
  });
});

describe("Phishing.Database fixtures parse to expected rows (#606)", () => {
  it("parses the domain list", () => {
    expect(
      parseFeedContent(
        "generic-list",
        "DOMAIN",
        fixture("phishing-database-domains.txt"),
      ),
    ).toEqual([
      { matchValue: "phishing-login.example" },
      { matchValue: "secure-update.example" },
      { matchValue: "account-verify.example" },
    ]);
  });

  it("parses the URL list (http/https only, canonical)", () => {
    expect(
      parseFeedContent(
        "generic-list",
        "URL",
        fixture("phishing-database-urls.txt"),
      ),
    ).toEqual([
      { matchValue: "http://phishing-login.example/signin" },
      { matchValue: "https://secure-update.example/account/verify" },
      { matchValue: "http://account-verify.example/login.php" },
    ]);
  });

  it("parses the IP list", () => {
    expect(
      parseFeedContent(
        "generic-list",
        "IP",
        fixture("phishing-database-ips.txt"),
      ),
    ).toEqual([
      { matchValue: "203.0.113.20" },
      { matchValue: "198.51.100.77" },
      { matchValue: "192.0.2.123" },
    ]);
  });
});

describe("Phishing.Database hit/miss per list (#606)", () => {
  const valuesOf = (entityType: "DOMAIN" | "URL" | "IP", file: string) =>
    new Set(
      parseFeedContent("generic-list", entityType, fixture(file)).map(
        (r) => r.matchValue,
      ),
    );

  it("domain list hits a listed domain and misses an unlisted one", () => {
    const set = valuesOf("DOMAIN", "phishing-database-domains.txt");
    expect(set.has("phishing-login.example")).toBe(true);
    expect(set.has("good.example")).toBe(false);
  });

  it("URL list hits a listed URL and misses an unlisted one", () => {
    const set = valuesOf("URL", "phishing-database-urls.txt");
    expect(set.has("http://phishing-login.example/signin")).toBe(true);
    expect(set.has("http://good.example/home")).toBe(false);
  });

  it("IP list hits a listed IP and misses an unlisted one", () => {
    const set = valuesOf("IP", "phishing-database-ips.txt");
    expect(set.has("203.0.113.20")).toBe(true);
    expect(set.has("203.0.113.99")).toBe(false);
  });
});
