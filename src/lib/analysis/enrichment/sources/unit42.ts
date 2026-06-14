// Palo Alto Unit 42 — vendor IOC repository (RFC 0003 F4, #623).
//
// RFC 0003 Appendix A vetted Palo Alto Unit 42
// (`PaloAltoNetworks/Unit42-Threat-Intelligence-Article-Information`) as
// USE-OK-DIRECT under The Unlicense (public domain, no attribution
// obligation). It ships IOCs bundled with article-level report context (actor /
// cluster / malware family) — first-party C1 narrative material — so it onboards
// as a self-registering vendor-repo source on the merged F4 engine (#603): the
// importer enumerates the repo tree, fetches only allowlisted blobs, and folds
// every file's rows into ONE snapshot replace per source.
//
// This is the FIRST vendor-repo source to land. The repo is FLAT (~24 files at
// the root, no directory hierarchy); context (dates, cluster ids such as
// `CL-STA-0910`) lives in the filename and in-file headers. Formats are mostly
// `.txt` IOC lists (defanged, inconsistently — `hxxp`/`hXXp` casing, partial
// `[.]`/`(.)` bracketing; SHA256 never defanged), plus multi-MB `.csv`
// (JSON-in-a-cell), narrative `.md`, an ~18 MB `.pdf`, and `.py` IDAPython
// scripts.
//
// v1 allowlists ONLY `.txt` and parses it with the `free-text` scanner (#603),
// which self-classifies IP/DOMAIN/URL/HASH by value shape and refangs by
// default — so the defanged prose lists and pure-hash dumps parse with no
// bespoke code. Everything else is excluded by default and never fetched: the
// `.pdf` and `.py` binaries/scripts, the `.csv` (JSON-in-cell with embedded
// newlines — deferred), and the `.md` appendices (their "indicators" are host
// artifacts — file paths / registry keys / DLL names — not network IOCs).
//
// The repo is pinned at a commit `ref` so the fixture tree is reproducible. A
// keyless fetch (60 req/hr) is ample for the 1 h cadence floor; an operator
// GitHub token (`authKeyName`) is a separate concern. `floorEligible: false`
// pending RFC 0003 OQ9.

import {
  FEED_MAX_AGE_MS,
  registerTiSource,
  type TiSourceDescriptor,
} from "./registry";

const UNIT42: TiSourceDescriptor = {
  sourcePolicyId: "unit42/threat-intel",
  label: "Palo Alto Unit 42 (Unlicense)",
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
    owner: "PaloAltoNetworks",
    repo: "Unit42-Threat-Intelligence-Article-Information",
    ref: "68070f9858bc85147fd36e652c84529df9225dba",
    // Single allowlist rule: the defanged `.txt` IOC lists + pure-hash dumps.
    // Everything else (`.pdf`/`.py`/`.csv`/`.md`) matches no rule and is never
    // fetched (the enforce-by-default binary / non-IOC skip).
    files: [
      {
        label: "ioc-list",
        pathPattern: "\\.txt$",
        parse: "free-text",
        parseConfig: { kind: "free-text", refang: true },
        // Self-classifying scanner — this is only the fallback entity type.
        entityType: "IP",
      },
    ],
    deterministicAllowed: true,
    // Capture the cluster id from the filename where present (best-effort). Only
    // `actor` / `campaign` / `malwareFamily` named groups reach row context.
    contextPattern: "(?<campaign>CL-[A-Z]+-\\d+)",
    // Per-row provenance: the per-file GitHub blob URL (#591 citation surface),
    // independent of which context groups matched.
    reportUrlTemplate: "https://github.com/{owner}/{repo}/blob/{ref}/{path}",
    fixtureDir: "unit42-fixture",
  },
};

registerTiSource(UNIT42);
