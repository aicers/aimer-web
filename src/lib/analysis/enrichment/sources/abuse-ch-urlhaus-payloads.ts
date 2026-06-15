// abuse.ch URLhaus "Collected Payloads" — malware artifact hashes (Tier-1).
//
// A separate URLhaus download from the URL feed, keyed by MD5/SHA-256 hash,
// under its own `abuse.ch/urlhaus-payloads` source so it does not clobber the
// URL/host snapshot. Self-fetch pulls the Collected Payloads export — a ZIP
// archive (`payload.csv.zip`) with the Auth-Key embedded in the URL path (the
// documented abuse.ch method; no `Auth-Key` header). The single inner CSV
// decompresses to ~2.6 GB (far past Node's max string), so the engine streams
// it end to end (ZIP-inflate → line parse → staging table → replace), gated by
// `decompress: "zip"`. It is a large full dump — not a "recent" delta — so the
// cadence floor is hours (a 219 MB pull every 5 min would be wrong) and a long
// per-source timeout covers the multi-hundred-MB download.

import {
  FEED_MAX_AGE_MS,
  FETCH_AUTH_KEY_PLACEHOLDER,
  registerTiSource,
  SIX_HOURS_MS,
  THIRTY_MINUTES_MS,
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
      `https://urlhaus-api.abuse.ch/v2/files/exports/${FETCH_AUTH_KEY_PLACEHOLDER}/payload.csv.zip`,
    ],
    cadenceFloorMs: SIX_HOURS_MS,
    timeoutMs: THIRTY_MINUTES_MS,
    decompress: "zip",
    parse: "urlhaus-payloads-csv",
    authKeyName: "urlhaus",
  },
  fixtureFile: "urlhaus-payloads.csv",
});
