// Infoblox Threat Intelligence — domain-heavy membership + classification feed
// (RFC 0003 Appendix A, fan-out source #605). CC-BY-4.0, vetted USE-OK-DIRECT.
//
// Upstream (`infobloxopen/threat-intelligence`, `indicators/csv/*.csv`) is one
// mixed CSV schema — `type,indicator,classification,detected_date` — where the
// indicator type is a per-row data value (`domain`/`ip`/`ipv4`/`url`/`sha256`/
// `email`/`telfhash`/…) and the values are defanged (`[.]`, `hxxp`, …). So this
// source uses the generalized `csv-column` parser (#605) in its row-typed mode:
// the `indicator` value column, the per-row `type` column mapped to entity
// types, a `classification` allowlist (the `classification` column mixes threat
// labels with non-threat ones like `legitimate`, which must NOT import as
// deterministic IOCs), and `refang`. Types absent from the map (`email`,
// `telfhash`, future drift) and classifications absent from the allowlist are
// skipped, so neither breaks nor clears the source.
//
// CC-BY-4.0 (hard obligation): the upstream wording is "attribution to Infoblox
// and the license". The descriptor `label` carries that attribution verbatim so
// the IOC-evidence citation surface (#591) discharges it wherever a matched
// Infoblox indicator surfaces.
//
// Fixture-only this issue: there is no single aggregate "latest" endpoint (many
// per-campaign files), so a static `fetch.urls` list would be brittle and
// immediately stale. A directory-enumerating self-fetch is a separate follow-up
// (omit `fetch`, like `spamhaus/edrop`).

import type { CsvColumnParseConfig } from "../feed-source";
import type { EntityType } from "../types";
import { FEED_MAX_AGE_MS, registerTiSource } from "./registry";

/**
 * Per-row `type` value → `EntityType`. `ipv4` aliases `ip` (both → `IP`).
 * `email` (no `EntityType`) and `telfhash` (not an MD5/SHA1/SHA256 digest, so
 * `normalizeHash` would throw) are intentionally absent → their rows are
 * skipped by the parser rather than errored.
 */
const INFOBLOX_TYPE_MAP: Readonly<Record<string, EntityType>> = {
  domain: "DOMAIN",
  ip: "IP",
  ipv4: "IP",
  url: "URL",
  sha256: "HASH",
};

/**
 * Threat-classification allowlist decided by issue #605, grounded in the full
 * `classification` vocabulary across the current `indicators/csv/*.csv` files.
 * An **allowlist** (not a denylist) so a NEW upstream value is excluded by
 * default until someone consciously adds it here. The excluded non-threat /
 * status labels (`legitimate`, `parked`, `nameserver`, `unavailable`,
 * `suspended`, `other`) are dropped — they are not IOCs.
 */
const INFOBLOX_THREAT_CLASSIFICATIONS: readonly string[] = [
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
];

const INFOBLOX_PARSE_CONFIG: CsvColumnParseConfig = {
  kind: "csv-column",
  typeColumn: {
    value: { name: "indicator" },
    type: { name: "type" },
    typeMap: INFOBLOX_TYPE_MAP,
  },
  rowFilter: {
    column: { name: "classification" },
    allow: INFOBLOX_THREAT_CLASSIFICATIONS,
  },
  refang: true,
  skipHeader: true,
};

registerTiSource({
  sourcePolicyId: "infoblox/threat-intelligence",
  label: "Infoblox Threat Intelligence (CC-BY-4.0)",
  entityTypes: ["DOMAIN", "IP", "URL", "HASH"],
  deterministicCoverage: true,
  maxAge: FEED_MAX_AGE_MS,
  floorEligible: false,
  parse: "csv-column",
  parseConfig: INFOBLOX_PARSE_CONFIG,
  // Dominant default; the per-row `type` column wins for every emitted row.
  entityType: "DOMAIN",
  hitType: "deterministic_ioc",
  classification: "infoblox",
  fixtureFile: "infoblox-threat-intelligence.csv",
});
