// Spamhaus EDROP — extended DROP CIDR blocklist (RFC 0003 Tier-1).
//
// EDROP was merged into DROP upstream in 2024, so there is no separate EDROP
// download: this source has NO self-fetch config and is supplied only via the
// committed fixture / manual upload (legacy `<CIDR> ; <SBLref>` text form).

import { FEED_MAX_AGE_MS, registerTiSource } from "./registry";

registerTiSource({
  sourcePolicyId: "spamhaus/edrop",
  label: "Spamhaus EDROP",
  entityTypes: ["IP"],
  deterministicCoverage: true,
  maxAge: FEED_MAX_AGE_MS,
  floorEligible: false,
  parse: "spamhaus-drop",
  entityType: "IP",
  hitType: "deterministic_ioc",
  classification: "edrop",
  selfFetchUnavailable: "merged",
  fixtureFile: "spamhaus-edrop.txt",
});
