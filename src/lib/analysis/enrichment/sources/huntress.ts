// Huntress — vendor IOC repository (RFC 0003 F4, #628).
//
// RFC 0003 Appendix A vetted Huntress (`huntresslabs/threat-intel`) as
// USE-OK-DIRECT under MIT (retain the notice; the README adds a no-warranty
// disclaimer — attribution lives in the `label`). It onboards as a
// self-registering vendor-repo source on the merged
// F4 engine (#603): the importer enumerates the repo tree, fetches only
// allowlisted blobs, and folds every file's rows into ONE snapshot replace per
// source.
//
// This is the THINNEST of the seven vendor repos BY DESIGN. ~90% of the repo is
// Sigma/YARA detection rules (`.yml` / `.yar` / `.yara`) — detection logic, not
// atomic IOCs — plus a stray `.ps1` and a `.DS_Store`. Atomic IOCs live in just
// a handful of per-incident CSVs (`type,data,info`). v1 ships the plumbing;
// volume grows as Huntress adds CSVs.
//
// The single allowlist rule matches `.csv` and parses it with the `free-text`
// scanner (#603), which self-classifies IP/DOMAIN/URL/HASH by VALUE SHAPE and
// refangs by default. But value-shape scanning alone is a hazard here: the CSV
// mixes atomic-IOC rows (`sha256`/`ip`/`domain`/`url`/…) with non-IOC rows whose
// `data`/`info` cells LOOK like IOCs — a `description,<blog-url>,…` metadata row,
// a `sig:Defender,…,BlackByte.SZ` signature name, an `ssl_certificate_serial`
// hex value, a `url_path` cell mentioning `window.open`. The scanner does not
// understand the `type` column, so it would emit each as a false positive.
//
// The fix is the additive `keepLinePattern` line-allowlist on the `free-text`
// parser (#628): only rows whose `type` column is an atomic-IOC type are scanned
// (whitespace-tolerant — Huntress has trailing-space keys), which SIMULTANEOUSLY
// drops the blog-URL `description` row AND the `sig:` / `ssl_certificate_serial`
// / `url_path` / `workstation` / `filename` junk rows. Everything not matched by
// the file rule (`.yml`/`.yar`/`.yara`/`.ps1`/`.DS_Store`) is excluded simply by
// the absence of a rule — never fetched.
//
// `contextPattern` reads the path INCLUDING the filename (the CSVs are named
// `<date>_<incident>.csv` directly under the month folder, so the incident name
// is in the filename, not a parent dir). No `reportUrl` in v1: the per-CSV blog
// URL lives in a `description` cell, and `readmeContext` is directory-scoped so
// it would collide across the multiple CSVs sharing one month folder — a
// file-scoped context primitive is a deferred follow-up. `floorEligible: false`
// pending RFC 0003 OQ9.

import {
  FEED_MAX_AGE_MS,
  registerTiSource,
  type TiSourceDescriptor,
} from "./registry";

const HUNTRESS: TiSourceDescriptor = {
  sourcePolicyId: "huntress/threat-intel",
  label: "Huntress (MIT)",
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
  classification: "vendor-report",
  vendorRepo: {
    owner: "huntresslabs",
    repo: "threat-intel",
    ref: "8fda9d338049111f29e5f68e053b9315eefa759b",
    // Single allowlist rule: the per-incident `type,data,info` CSVs, gated by a
    // positive type-allowlist so only atomic-IOC-type rows are scanned. Anything
    // else (`.yml`/`.yar`/`.yara`/`.ps1`/`.DS_Store`) matches no rule and is
    // never fetched.
    files: [
      {
        label: "ioc-csv",
        pathPattern: "\\.csv$",
        parse: "free-text",
        parseConfig: {
          kind: "free-text",
          refang: true,
          // Keep only rows whose `type` column is an atomic-IOC type (trailing
          // whitespace on the key tolerated). Drops the `description` blog-URL
          // row and the `sig:` / `ssl_certificate_serial` / `url_path` / … junk.
          // The bare `ip` branch additionally rejects CIDR-shaped data cells via
          // a negative lookahead (`(?![^,]*/\d)`): an upstream `ip,43.173.64.0/18`
          // row would otherwise be kept and the value-shape scanner would emit
          // the bare `43.173.64.0` — a misleading exact-host IOC that is NOT the
          // `/18` network. This source carries only IP/DOMAIN/URL/HASH atomics
          // (no network entity type), so CIDR rows are dropped rather than
          // mis-imported. `ip:port` rows (no `/`) and all other atomic types are
          // unaffected.
          keepLinePattern:
            "^\\s*(?:(?:sha256|sha1|md5|ip:port|domain|url)\\s*,|ip\\s*,(?![^,]*/\\d))",
        },
        // Self-classifying scanner — this is only the fallback entity type.
        entityType: "IP",
        contentClass: "vendor-report",
      },
    ],
    deterministicAllowed: true,
    // Capture the incident/campaign from the filename (the CSVs sit directly
    // under the month folder as `<date>_<incident>.csv`). Only `actor` /
    // `campaign` / `malwareFamily` named groups reach row context. The class is
    // mixed-case on purpose: real upstream filenames include shapes like
    // `20260611_kali365-IoCs.csv`, so a lowercase-only class would silently fail
    // to match and drop the incident context for that (high-yield) CSV.
    contextPattern: "_(?<campaign>[A-Za-z0-9-]+)\\.csv$",
    fixtureDir: "huntress-fixture",
  },
};

registerTiSource(HUNTRESS);
