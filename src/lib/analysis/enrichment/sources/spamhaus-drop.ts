// Spamhaus DROP — "Don't Route Or Peer" hijacked/leased CIDR blocklist (Tier-1).
//
// The committed fixtures / manual uploads use the legacy `<CIDR> ; <SBLref>`
// text form (`spamhaus-drop`); self-fetch pulls the NDJSON `drop_v4.json` +
// `drop_v6.json` as published over HTTP today (`spamhaus-drop-ndjson`). EDROP
// was merged into DROP in 2024, so only DROP is self-fetched. Over-fetching
// risks an IP firewall — floor 1 h.

import { FEED_MAX_AGE_MS, ONE_HOUR_MS, registerTiSource } from "./registry";

registerTiSource({
  sourcePolicyId: "spamhaus/drop",
  label: "Spamhaus DROP",
  entityTypes: ["IP"],
  deterministicCoverage: true,
  maxAge: FEED_MAX_AGE_MS,
  floorEligible: false,
  parse: "spamhaus-drop",
  entityType: "IP",
  hitType: "deterministic_ioc",
  classification: "drop",
  fetch: {
    urls: [
      "https://www.spamhaus.org/drop/drop_v4.json",
      "https://www.spamhaus.org/drop/drop_v6.json",
    ],
    cadenceFloorMs: ONE_HOUR_MS,
    parse: "spamhaus-drop-ndjson",
  },
  fixtureFile: "spamhaus-drop.txt",
});
