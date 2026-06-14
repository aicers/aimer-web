// Volexity — vendor IOC repository (RFC 0003 F4, #625).
//
// RFC 0003 Appendix A vetted Volexity (`volexity/threat-intel`) as
// USE-OK-DIRECT under BSD-2-Clause (`LICENSE.txt`, retain copyright/notice). It
// ships per-report CSV IOCs bundled with actor / campaign context — first-party
// C1 narrative material — so it onboards as a self-registering vendor-repo
// source on the merged F4 engine (#603): the importer enumerates the repo tree,
// fetches only allowlisted blobs, and folds every file's rows into ONE snapshot
// replace per source.
//
// The repo is `YYYY/` year folders → one folder per blog post; the IOC CSV sits
// at the post root (`iocs.csv`) OR under an `indicators/` subfolder
// (`indicators.csv`) — both coexist, so the allowlist matches either by name at
// any depth (recurse, don't assume depth). The CSV header drifts
// (`value,entity_type,description` in 2024+, `value,type,notes` in 2018) but the
// IOC is always column 0 (`value`); the sibling `entity_type` column uses a
// non-standard, drifting vocab (`hostname` / `ipaddress` / `file`) and `file`
// cells pack 2-3 hashes in one quoted cell.
//
// Whole-line `free-text` over the CSV is NOT data-safe here: the scanner's URL
// regex does not stop at a comma (so a `url` row absorbs its trailing CSV
// fields) and it scans the entire line (so a benign domain/URL in the
// `description` column leaks in as a false-positive IOC). So this v1 isolates
// the `value` column with `csv-column` in its `shapeColumn` mode (#625): parse
// the CSV, read ONLY column 0, and shape-classify each cell via the free-text
// scanner — DOMAIN / IP / HASH / URL by value shape, splitting a `file` cell's
// packed hashes per hash and refanging the few `hxxp://` rows. URL IOCs are
// included but sourced ONLY from the isolated value cell, so the comma bug
// cannot fire and the description column is never scanned.
//
// `attachments/` (live web-shell source), `scripts/` tooling, and `*.yar` rule
// files match NO `files` rule — they are never fetched (the enforce-by-default
// binary / rule-file skip). The repo is pinned at a commit `ref` so the fixture
// tree is reproducible; a keyless GitHub fetch (60 req/hr) covers the 1 h
// cadence floor, with an optional operator token a separate concern.
// `floorEligible: false` pending RFC 0003 OQ9.

import {
  FEED_MAX_AGE_MS,
  registerTiSource,
  type TiSourceDescriptor,
} from "./registry";

const VOLEXITY: TiSourceDescriptor = {
  sourcePolicyId: "volexity/threat-intel",
  label: "Volexity (BSD-2-Clause)",
  entityTypes: ["DOMAIN", "IP", "HASH", "URL"],
  deterministicCoverage: true,
  maxAge: FEED_MAX_AGE_MS,
  floorEligible: false,
  // Import-time defaults. A vendor-repo source still REQUIRES these; the actual
  // per-file extraction is driven by `vendorRepo.files[].parse`. `free-text` is
  // the universal fallback the engine would stamp for a file whose parser did
  // not self-classify — the `csv-column`/`shapeColumn` rule below always does.
  parse: "free-text",
  entityType: "DOMAIN",
  hitType: "deterministic_ioc",
  classification: "vendor_report",
  vendorRepo: {
    owner: "volexity",
    repo: "threat-intel",
    ref: "5fd84467b3ecfddb0db2f2b9ae747d70c6d56492",
    // Single allowlist rule: the per-report IOC CSV, at the post root
    // (`iocs.csv`) or under `indicators/` (`indicators.csv`), at any depth.
    // `shapeColumn` reads ONLY column 0 (`value`) and shape-classifies each
    // cell, so the URL comma-bug and description-column false positives of a
    // whole-line `free-text` scan cannot fire. Everything else
    // (`attachments/`, `scripts/`, `*.yar`) matches no rule and is never
    // fetched.
    files: [
      {
        label: "iocs-csv",
        pathPattern: "(?:^|/)(?:iocs|indicators)\\.csv$",
        parse: "csv-column",
        parseConfig: {
          kind: "csv-column",
          shapeColumn: { value: { index: 0 } },
          skipHeader: true,
          refang: true,
        },
        // Self-classifying scanner — this is only the fallback entity type.
        entityType: "DOMAIN",
      },
    ],
    deterministicAllowed: true,
    // Capture the post codename/date from the folder path (folder = context in
    // v1; per-row `description` is not threaded). Only `actor` / `campaign` /
    // `malwareFamily` named groups reach row context.
    contextPattern: "(?<campaign>[0-9]{4}-[0-9]{2}-[0-9]{2}[^/]*)",
    // Per-row provenance: the per-file GitHub blob URL (#591 citation surface).
    reportUrlTemplate: "https://github.com/{owner}/{repo}/blob/{ref}/{path}",
    fixtureDir: "volexity-fixture",
  },
};

registerTiSource(VOLEXITY);
