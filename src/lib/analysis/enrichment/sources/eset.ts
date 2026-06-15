// ESET — vendor IOC repository (RFC 0003 F4, #624).
//
// RFC 0003 Appendix A vetted ESET (`eset/malware-ioc`) as USE-OK-DIRECT under
// BSD-2-Clause (permissive; retain copyright / notice). It ships clean
// per-family hash lists bundled with report context (actor / family) — first-
// party C1 narrative material — so it onboards as a self-registering vendor-repo
// source on the merged F4 engine (#603): the importer enumerates the repo tree,
// fetches only allowlisted blobs, and folds every file's rows into ONE snapshot
// replace per source.
//
// The repo is organized as one folder per malware family / actor (100+ folders;
// some nest, e.g. `invisimole/sigma/`). Folder names are usually lowercase
// (`gamaredon/`, `sednit/`) but some are mixed-case (`GhostRedirector/`,
// `PlushDaemon/`), so the `contextPattern` capture must not assume lowercase.
// Context (the malware family) lives in the folder name; per-folder narrative is
// in `README.adoc` (deferred — see below).
//
// v1 allowlists ONLY the flat `samples.sha256` hash lists (one SHA256 per line,
// no header/BOM) and parses them with `generic-list` (#593). The bare hashes are
// NOT defanged, so `parseGenericList`'s default-OFF refang is correct. Everything
// else is excluded by default and never fetched: the `.adoc` narrative (also the
// per-folder `README.adoc`), `.yar` YARA rules, `.json` MISP exports, `.yml`
// Sigma rules, `.pem`, and `.txt`. Network IOCs (IPs / domains) live only inside
// the `.adoc` prose and are deferred to a follow-up.
//
// `readmeContext` is intentionally NOT set: enabling it would make the engine
// fetch the matching `README.adoc` blobs for context, which contradicts the v1
// "no `.adoc` ever fetched" guarantee. v1 derives the malware family from the
// path (`contextPattern`) only. README-derived actor / report-link is an
// optional follow-up.
//
// Manual-upload note: a vendor-repo source cannot be manual-uploaded — a single
// concatenated file would write a partial, context-stripped snapshot — so ESET
// is hidden from the manual-upload table and rejected by the upload route
// (`feed-upload.ts`). Vendor repositories are refreshed in `self-fetch` mode
// only.
//
// The repo is pinned at a commit `ref` so the fixture tree is reproducible
// (default branch is `master`, NOT `main`). A keyless fetch (60 req/hr) is ample
// for the 1 h cadence floor; an operator GitHub token (`authKeyName`) is a
// separate concern. BSD-2-Clause requires attribution — the `label` carries it
// (#591 citation surface). `floorEligible: false` pending RFC 0003 OQ9.

import {
  FEED_MAX_AGE_MS,
  GITHUB_VENDOR_AUTH_KEY_NAME,
  registerTiSource,
  type TiSourceDescriptor,
} from "./registry";

const ESET: TiSourceDescriptor = {
  sourcePolicyId: "eset/malware-ioc",
  label: "ESET (BSD-2-Clause)",
  entityTypes: ["HASH"],
  deterministicCoverage: true,
  maxAge: FEED_MAX_AGE_MS,
  floorEligible: false,
  // Import-time defaults. A vendor-repo source still REQUIRES these; the actual
  // per-file extraction is driven by `vendorRepo.files[].parse`, while these are
  // the fallbacks the engine stamps onto the snapshot.
  parse: "generic-list",
  parseConfig: { kind: "generic-list" },
  entityType: "HASH",
  hitType: "deterministic_ioc",
  classification: "vendor_report",
  vendorRepo: {
    owner: "eset",
    repo: "malware-ioc",
    // Pinned to a verified `master` SHA (default branch is `master`, not
    // `main`); the fixture tree mirrors this pin.
    ref: "06925402a23e98cbacea58bf4bd471307412956f",
    // Single allowlist rule: the clean flat `samples.sha256` hash lists. The
    // bare hashes are not defanged, so `generic-list`'s default-OFF refang is
    // correct. Everything else (`.adoc`/`.yar`/`.json`/`.yml`/`.pem`/`.txt`)
    // matches no rule and is never fetched.
    files: [
      {
        label: "samples-sha256",
        pathPattern: "samples\\.sha256$",
        parse: "generic-list",
        parseConfig: { kind: "generic-list" },
        entityType: "HASH",
      },
    ],
    deterministicAllowed: true,
    // Folder name → malware family. Case-insensitive on the folder segment
    // (some folders are mixed-case, e.g. `GhostRedirector/`). Only `actor` /
    // `campaign` / `malwareFamily` named groups reach row context.
    contextPattern: "^(?<malwareFamily>[^/]+)/",
    // Per-row provenance: the per-file GitHub blob URL (#591 citation surface),
    // independent of which context groups matched.
    reportUrlTemplate: "https://github.com/{owner}/{repo}/blob/{ref}/{path}",
    // Optional shared GitHub token (#650): keyless still works (60 req/hr);
    // a token lifts the shared REST limit to 5,000 req/hr.
    authKeyName: GITHUB_VENDOR_AUTH_KEY_NAME,
    fixtureDir: "eset-fixture",
  },
};

registerTiSource(ESET);
