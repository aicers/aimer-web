// PRODAFT — vendor IOC repository (RFC 0003 F4, #626).
//
// RFC 0003 Appendix A vetted PRODAFT (`prodaft/malware-ioc`) as USE-OK-DIRECT
// under MIT (`Copyright (c) 2025 PRODAFT`; retain the notice). It ships
// per-investigation IOCs embedded in narrative reports — first-party C1
// narrative material — so it onboards as a self-registering vendor-repo source
// on the merged F4 engine (#603): the importer enumerates the repo tree,
// fetches only allowlisted blobs, and folds every file's rows into ONE snapshot
// replace per source. No parser / engine change — config only.
//
// This is the binary-guard showcase. The upstream repo ships LIVE executable
// `.exe` files (PRODAFT-built ransomware decryptors — 16 of them), so it
// exercises the engine's enforce-by-default allowlist: a blob whose path
// matches no `files` rule is NEVER downloaded. The single allowlist rule below
// scopes to per-investigation `README.md` files (the `.+/` prefix excludes the
// root README, which carries no IOCs); everything else — the `.exe` samples,
// the `images/`, the PDF reports, the `.py`/`.go`/`.js` tooling — matches no
// rule and is never fetched. The ONLY engine-level binary defense is this path
// allowlist (there is no magic-byte / per-blob size scan), so it is kept tight.
//
// Layout: one folder per investigation, named by PRODAFT codename
// (`RagnarLoader/`, `Matanbuchus/`, `LARVA-NNN/`, …). Each centers on a
// `README.md` holding the narrative plus IOCs in Markdown tables (hashes) and
// fenced code blocks (IPs / domains / URLs). The `free-text` scanner (#603)
// pulls IP/DOMAIN/URL/HASH out of that prose and self-classifies each token by
// value shape, so the `entityType` on the file rule is only a nominal default.
// Refang is on by default; PRODAFT's IOCs are mostly LIVE/un-defanged (never
// auto-resolve), but refang is harmless on plain values and salvages the
// occasional defanged link in a code block.
//
// Codenames do not map to public actor names, so the folder codename is stored
// verbatim as `actor` context via `contextPattern`. The repo is pinned at a
// `master` SHA (the default branch is `master`, NOT `main` — `main` 422-fails
// on the GitHub API) so the fixture tree is reproducible. A keyless fetch is
// ample for the 1 h cadence floor; an operator GitHub token (`authKeyName`) is
// a separate concern. `floorEligible: false` pending RFC 0003 OQ9.

import {
  FEED_MAX_AGE_MS,
  GITHUB_VENDOR_AUTH_KEY_NAME,
  registerTiSource,
  type TiSourceDescriptor,
} from "./registry";

const PRODAFT: TiSourceDescriptor = {
  sourcePolicyId: "prodaft/malware-ioc",
  label: "PRODAFT (MIT)",
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
    owner: "prodaft",
    repo: "malware-ioc",
    ref: "6ecbec2f66cf18ea869e596ef451a072539ae588",
    // Single allowlist rule: the per-investigation `README.md` reports. The
    // `.+/` prefix scopes to a sub-folder README (excludes the root README,
    // which carries no IOCs). Everything else — most importantly the live
    // `.exe` samples, plus `images/`, `.pdf`, `.py`/`.go`/`.js` — matches no
    // rule and is never fetched (the enforce-by-default binary skip).
    files: [
      {
        label: "investigation-readme",
        pathPattern: ".+/README\\.md$",
        parse: "free-text",
        parseConfig: { kind: "free-text", refang: true },
        // Self-classifying scanner — this is only the fallback entity type.
        entityType: "IP",
      },
    ],
    deterministicAllowed: true,
    // Folder codename → `actor` context (stored verbatim; codenames do not map
    // to public actor names).
    contextPattern: "^(?<actor>[^/]+)/",
    // Per-row provenance: the per-file GitHub blob URL (#591 citation surface).
    reportUrlTemplate: "https://github.com/{owner}/{repo}/blob/{ref}/{path}",
    // Optional shared GitHub token (#650): keyless still works (60 req/hr);
    // a token lifts the shared REST limit to 5,000 req/hr.
    authKeyName: GITHUB_VENDOR_AUTH_KEY_NAME,
    fixtureDir: "prodaft-fixture",
  },
};

registerTiSource(PRODAFT);
