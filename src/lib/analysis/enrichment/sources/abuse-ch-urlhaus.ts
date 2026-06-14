// abuse.ch URLhaus — malware-distribution URL feed (RFC 0003 Tier-1).
//
// Emits both URL rows and the DOMAIN host of each URL under the one
// `abuse.ch/urlhaus` source (its policy declares `["URL", "DOMAIN"]`), so a
// bare `host`/`dns_query` member matches the same infrastructure. The dual-row
// emission lives in `parseFeedContent`'s `urlhaus-csv` case. Self-fetch uses
// the URL export CSV with the Auth-Key embedded in the URL path, regenerated
// every 5 min — floor 5 min.

import {
  FEED_MAX_AGE_MS,
  FETCH_AUTH_KEY_PLACEHOLDER,
  FIVE_MINUTES_MS,
  registerTiSource,
} from "./registry";

registerTiSource({
  sourcePolicyId: "abuse.ch/urlhaus",
  label: "abuse.ch URLhaus",
  entityTypes: ["URL", "DOMAIN"],
  deterministicCoverage: true,
  maxAge: FEED_MAX_AGE_MS,
  floorEligible: false,
  parse: "urlhaus-csv",
  entityType: "URL",
  hitType: "deterministic_ioc",
  classification: "malware_url",
  fetch: {
    urls: [
      `https://urlhaus-api.abuse.ch/v2/urls/exports/${FETCH_AUTH_KEY_PLACEHOLDER}/recent.csv`,
    ],
    cadenceFloorMs: FIVE_MINUTES_MS,
    parse: "urlhaus-csv",
    authKeyName: "urlhaus",
  },
  fixtureFile: "urlhaus.csv",
});
