// Meta Threat Research — vendor IOC repository (RFC 0003 F4, #629).
//
// RFC 0003 Appendix A vetted Meta (`facebook/threat-research`) as USE-OK-DIRECT
// under MIT (`Copyright (c) Meta Platforms, Inc.` — retain the notice in the
// `label`). It onboards as a self-registering vendor-repo source on the merged
// F4 engine (#603): descriptor + `vendorRepo` config + pinned tree fixture, with
// NO parser/engine change.
//
// This is the CIB-guard showcase. Meta's content is overwhelmingly
// coordinated-inauthentic-behavior / influence-ops material — account / page
// counts and free-text narrative, NOT atomic network IOCs. The 68 committed CSVs
// split into 57 CIB kill-chain files (`Tactic,Technique,Procedure,Indicator,
// Notes`, whose `Indicator` column is mostly asset counts / prose) and 11 legacy
// malware files (`indicator_type,indicator_value,…`, genuine atomic IOCs). A
// single allowlist rule matches ALL of `indicators/csv/**` and parses each file
// with the `free-text` scanner (#603), which self-classifies IP/DOMAIN/URL/HASH
// by value shape and refangs — so the CIB count/narrative sentinels (`154
// Accounts`, `23 Pages`, prose sentences) match no IOC shape and are dropped,
// while the few real domains/URLs (and the legacy files' IOCs) emit.
//
// The load-bearing guard is `deterministicAllowed: false` (repo-level): the
// engine forces EVERY emitted row to `soft_reputation` regardless of what a file
// declared, so CIB / influence-ops attribution can never become a deterministic
// / floor-eligible `known_ioc_hit`. `free-text` is value-shape (not semantic),
// so an incidental domain-shaped prose token may still emit — but only ever as
// bounded soft noise, never a floor hit. `deterministicCoverage: false` and
// `hitType: "soft_reputation"` align the descriptor with that downgrade.
//
// Out of scope (config-only fan-out): the `.tsv` mirror, the `.json`/`.stix1`
// legacy paths, `.md` notes, and `signatures/yara/` rule files are excluded by
// default (no rule matches → never fetched). No `reportUrlTemplate` — Meta's
// paths carry spaces / `#` / `&` / non-ASCII that the engine's plain template
// interpolation cannot URL-encode, so a `{path}` blob URL would be malformed; a
// per-file blob URL would need an engine change. No `contextPattern` — the
// engine promotes only `actor`/`campaign`/`malwareFamily`, while Meta's path
// carries period/country/network, so rows are left context-less rather than
// forcing a mismatched mapping.

import {
  FEED_MAX_AGE_MS,
  registerTiSource,
  type TiSourceDescriptor,
} from "./registry";

const META: TiSourceDescriptor = {
  sourcePolicyId: "meta/threat-research",
  label: "Meta Threat Research (MIT)",
  entityTypes: ["DOMAIN", "URL", "IP", "HASH"],
  // CIB / influence-ops context, not malware infrastructure — it is never a
  // relevant deterministic source for coverage and never drives the floor.
  deterministicCoverage: false,
  maxAge: FEED_MAX_AGE_MS,
  floorEligible: false,
  // Import-time defaults. A vendor-repo source still REQUIRES these even though
  // the per-file `vendorRepo.files` rules drive the actual extraction; the
  // engine ignores them in favor of the file rules.
  parse: "free-text",
  entityType: "DOMAIN",
  // Aligns with the CIB downgrade: rows are soft reputation, never deterministic.
  hitType: "soft_reputation",
  classification: "vendor-cib",
  vendorRepo: {
    owner: "facebook",
    repo: "threat-research",
    ref: "a1b05bff1c29fe32e116c4a5eb35b0f0d4e717b1",
    // ONE rule matches every CSV under `indicators/csv/**`. `free-text`
    // self-classifies each token's entity type and refangs, so the CIB
    // count/narrative sentinels drop and the real domains/URLs (plus the legacy
    // files' atomic IOCs) emit. The `cib` content-class tag denotes repo-level
    // soft/CIB handling (it also tags the 11 legacy CSVs — that is fine, the tag
    // is not a precise per-file taxonomy). Everything not matching this pattern
    // — `.tsv` / `.json` / `.stix1` / `.md` / `.DS_Store` / `signatures/yara/` —
    // matches no rule and is never fetched.
    files: [
      {
        label: "cib-csv",
        pathPattern: "indicators/csv/.*\\.csv$",
        parse: "free-text",
        parseConfig: { kind: "free-text", refang: true },
        // Self-classifying scanner — this is only the fallback entity type.
        entityType: "DOMAIN",
        contentClass: "cib",
      },
    ],
    // THE guard: every emitted row is forced to `soft_reputation` centrally,
    // regardless of any per-row `hitType`. CIB attribution must never drive a
    // deterministic / floor-eligible hit.
    deterministicAllowed: false,
    // No `reportUrlTemplate` / `contextPattern` — see the module header.
    fixtureDir: "meta-fixture",
  },
};

registerTiSource(META);
