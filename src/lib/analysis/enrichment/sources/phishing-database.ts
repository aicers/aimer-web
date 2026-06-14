// Phishing.Database — bulk phishing domain / URL / IP membership lists
// (RFC 0003 Tier-1, Appendix A: MIT, USE-OK-DIRECT).
//
// PyFunceble-validated, GitHub-hosted lists, one indicator per line of plain
// text, so each list parses with the parameterized `generic-list` parser (#593)
// — no bespoke parser. The repo publishes three separate lists (domains, links,
// IPs), so this file registers THREE descriptors, one per published list /
// entity type, each with its own `sourcePolicyId` and pinned fixture.
//
// Self-fetch pulls the validated / ACTIVE variants over `raw.githubusercontent.com`.
// That is a GitHub repo, not a 5-min export API, so the cadence floor is 1 h
// (`ONE_HOUR_MS`) — the 5-min floor exists only to avoid an abuse.ch / Spamhaus
// IP ban and does not apply here; a tighter floor would needlessly hammer GitHub.
// The raw URLs are public, so no Auth-Key is needed. The lists are plain (not
// defanged) with no comment lines, so the bare `generic-list` defaults (strip
// blanks + `#`/`;` comments, refang off) suffice and no `parseConfig` is set.
//
// Coverage note: `generic-list` cannot derive a host from a URL (unlike the
// bespoke URLhaus parser), so `phishing-database/url` matches canonical URLs
// only; host/domain coverage comes solely from `phishing-database/domain`.

import { FEED_MAX_AGE_MS, ONE_HOUR_MS, registerTiSource } from "./registry";

registerTiSource({
  sourcePolicyId: "phishing-database/domain",
  label: "Phishing.Database (domains)",
  entityTypes: ["DOMAIN"],
  deterministicCoverage: true,
  maxAge: FEED_MAX_AGE_MS,
  floorEligible: false,
  parse: "generic-list",
  entityType: "DOMAIN",
  hitType: "deterministic_ioc",
  classification: "phishing",
  fetch: {
    urls: [
      "https://raw.githubusercontent.com/Phishing-Database/Phishing.Database/master/phishing-domains-ACTIVE.txt",
    ],
    cadenceFloorMs: ONE_HOUR_MS,
    parse: "generic-list",
  },
  fixtureFile: "phishing-database-domains.txt",
});

registerTiSource({
  sourcePolicyId: "phishing-database/url",
  label: "Phishing.Database (URLs)",
  entityTypes: ["URL"],
  deterministicCoverage: true,
  maxAge: FEED_MAX_AGE_MS,
  floorEligible: false,
  parse: "generic-list",
  entityType: "URL",
  hitType: "deterministic_ioc",
  classification: "phishing",
  fetch: {
    urls: [
      "https://raw.githubusercontent.com/Phishing-Database/Phishing.Database/master/phishing-links-ACTIVE.txt",
    ],
    cadenceFloorMs: ONE_HOUR_MS,
    parse: "generic-list",
  },
  fixtureFile: "phishing-database-urls.txt",
});

registerTiSource({
  sourcePolicyId: "phishing-database/ip",
  label: "Phishing.Database (IPs)",
  entityTypes: ["IP"],
  deterministicCoverage: true,
  maxAge: FEED_MAX_AGE_MS,
  floorEligible: false,
  parse: "generic-list",
  entityType: "IP",
  hitType: "deterministic_ioc",
  classification: "phishing",
  fetch: {
    urls: [
      "https://raw.githubusercontent.com/Phishing-Database/Phishing.Database/master/phishing-IPs-ACTIVE.txt",
    ],
    cadenceFloorMs: ONE_HOUR_MS,
    parse: "generic-list",
  },
  fixtureFile: "phishing-database-ips.txt",
});
