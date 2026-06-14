// abuse.ch URLhaus "Collected Payloads" — malware artifact hashes (Tier-1).
//
// A separate URLhaus download from the URL feed, keyed by MD5/SHA-256 hash,
// under its own `abuse.ch/urlhaus-payloads` source so it does not clobber the
// URL/host snapshot. Self-fetch uses the files export CSV with the Auth-Key in
// the URL path, regenerated every 5 min — floor 5 min.

import {
  FEED_MAX_AGE_MS,
  FETCH_AUTH_KEY_PLACEHOLDER,
  FIVE_MINUTES_MS,
  registerTiSource,
} from "./registry";

registerTiSource({
  sourcePolicyId: "abuse.ch/urlhaus-payloads",
  label: "abuse.ch URLhaus (payloads)",
  entityTypes: ["HASH"],
  deterministicCoverage: true,
  maxAge: FEED_MAX_AGE_MS,
  floorEligible: false,
  parse: "urlhaus-payloads-csv",
  entityType: "HASH",
  hitType: "deterministic_ioc",
  classification: "malware_payload",
  fetch: {
    urls: [
      `https://urlhaus-api.abuse.ch/v2/files/exports/${FETCH_AUTH_KEY_PLACEHOLDER}/recent.csv`,
    ],
    cadenceFloorMs: FIVE_MINUTES_MS,
    parse: "urlhaus-payloads-csv",
    authKeyName: "urlhaus",
  },
  fixtureFile: "urlhaus-payloads.csv",
});
