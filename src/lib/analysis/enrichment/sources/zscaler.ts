// Zscaler ThreatLabz — vendor IOC repository (RFC 0003 F4, #627).
//
// RFC 0003 Appendix A vetted Zscaler ThreatLabz (`threatlabz/iocs`) as
// USE-OK-DIRECT under MIT (`Copyright (c) 2022 Zscaler ThreatLabz`; the notice
// is retained in this source's `label`). It ships per-campaign IOC lists —
// first-party material whose campaign/family context lives in the folder name —
// so it onboards as a self-registering vendor-repo source on the merged F4
// engine (#603): the importer enumerates the repo tree, fetches only allowlisted
// blobs, and folds every file's rows into ONE snapshot replace per source.
//
// The repo is FLAT with one folder per campaign/family at the root (depth
// exactly 1 — `qakbot/`, `emotet/`, `apt37/`, …); context is the folder name
// only (no per-report README / manifest), captured by `contextPattern` as the
// `campaign` key. Formats are overwhelmingly `.txt` (one indicator per line,
// inconsistently defanged — some plain, some `[.]`-bracketed), so v1 allowlists
// ONLY `.txt` and parses it with the `free-text` scanner (#603), which
// self-classifies IP/DOMAIN/URL/HASH by value shape and refangs by default.
//
// Everything else is excluded by default and never fetched: the victim-telemetry
// `.csv` (PII — `Username,Location,Timestamp,IP address,Email`), the Cobalt
// Strike beacon-config `.json` dumps, and the `.php`/`.hta`/`.yara`/`.yar`
// source/templates/rules all match no allowlist rule. ONE known-bad `.txt` is
// also dropped: `qakbot/payload_urls.txt` carries a concatenated-domain data
// defect (two domains run together into a single valid-looking DOMAIN token the
// `free-text` scanner would import as garbage), and the engine has no per-line
// malformed-line skip — so it is excluded config-only via a negative lookahead
// in the allowlist `pathPattern`. Per-line repair of that defect is out of scope.
//
// The repo is pinned at a commit `ref` so the fixture tree is reproducible. A
// keyless fetch (60 req/hr) is ample for the 1 h cadence floor; an operator
// GitHub token (`authKeyName`) is a separate concern. `floorEligible: false`
// pending RFC 0003 OQ9.

import {
  FEED_MAX_AGE_MS,
  GITHUB_VENDOR_AUTH_KEY_NAME,
  registerTiSource,
  type TiSourceDescriptor,
} from "./registry";

const ZSCALER: TiSourceDescriptor = {
  sourcePolicyId: "zscaler/threatlabz",
  label: "Zscaler ThreatLabz (MIT)",
  entityTypes: ["IP", "DOMAIN", "URL", "HASH"],
  deterministicCoverage: true,
  maxAge: FEED_MAX_AGE_MS,
  floorEligible: false,
  // Import-time defaults. A vendor-repo source still REQUIRES these; the actual
  // per-file extraction is driven by `vendorRepo.files[].parse`, while these are
  // the fallbacks the engine stamps when a file's parser did not self-classify.
  parse: "free-text",
  entityType: "IP",
  hitType: "deterministic_ioc",
  classification: "vendor_report",
  vendorRepo: {
    owner: "threatlabz",
    repo: "iocs",
    ref: "5f73ebab40a921d24acbdafd4b8c0861db21d0af",
    // Single allowlist rule: the per-campaign `.txt` IOC lists. The negative
    // lookahead drops the ONE known-bad file (`qakbot/payload_urls.txt`, a
    // concatenated-domain defect the engine cannot repair per-line). Everything
    // else (`.csv` PII, `.json` CS configs, `.php`/`.hta`/`.yara`/`.yar`) matches
    // no rule and is never fetched.
    files: [
      {
        label: "campaign-txt",
        pathPattern: "^(?!.*qakbot/payload_urls\\.txt$).*\\.txt$",
        parse: "free-text",
        parseConfig: { kind: "free-text", refang: true },
        // Self-classifying scanner — this is only the fallback entity type.
        entityType: "IP",
      },
    ],
    deterministicAllowed: true,
    // Depth-1 folder name → `campaign` context key. The repo carries no report
    // link / manifest, so there is no `reportUrlTemplate`.
    contextPattern: "^(?<campaign>[^/]+)/",
    // Optional shared GitHub token (#650): keyless still works (60 req/hr);
    // a token lifts the shared REST limit to 5,000 req/hr.
    authKeyName: GITHUB_VENDOR_AUTH_KEY_NAME,
    fixtureDir: "zscaler-fixture",
  },
};

registerTiSource(ZSCALER);
