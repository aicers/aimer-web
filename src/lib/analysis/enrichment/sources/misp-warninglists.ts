// MISP warninglists — the first negative / false-positive-suppression source
// (RFC 0003 F5, #615).
//
// MISP warninglists (`MISP/misp-warninglists`, CC0) are NOT a known-bad feed:
// they are known-good / known-noisy lists (public DNS resolvers, CDN / cloud IP
// ranges, bogons) used as an EXCLUDE / down-weight layer. A warninglisted
// indicator must never feed `known_ioc_hit`, so this is a `polarity: "negative"`
// source: registration enforces it carries NO `hitType` and sets
// `deterministicCoverage: false` + `floorEligible: false` (it can affect neither
// coverage nor the floor). Its rows surface only as `NegativeMatch[]` and drive
// the suppression pass (#599).
//
// v1 is fixture-only (no `fetch`, like `spamhaus/edrop`) and IP-oriented: the
// committed fixture bundles every list into ONE JSON-array payload, so the
// bespoke `misp-warninglist` parser flattens them into one snapshot replace with
// no per-list clobber. CC0 carries no attribution obligation, but the `label`
// records provenance for the citation surface (#591).

import { FEED_MAX_AGE_MS, registerTiSource } from "./registry";

registerTiSource({
  sourcePolicyId: "misp/warninglists",
  label: "MISP warninglists (CC0)",
  polarity: "negative",
  entityTypes: ["IP"],
  deterministicCoverage: false,
  maxAge: FEED_MAX_AGE_MS,
  floorEligible: false,
  parse: "misp-warninglist",
  entityType: "IP",
  fixtureFile: "misp-warninglists.json",
});
