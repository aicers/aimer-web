// MITRE ATT&CK vendor script — refresh `schemas/mitre-attack-techniques.json`
// from the upstream STIX 2.1 bundle at
// `github.com/mitre-attack/attack-stix-data`.
//
// The single source of truth for which upstream revision we vendor is
// `schemas/mitre-attack.version`. The script reads that pin, fetches the
// matching `enterprise-attack-<semver>.json` bundle, extracts each
// non-revoked, non-deprecated `attack-pattern` object's MITRE technique
// ID and human-readable name, and writes a sorted JSON array to
// `schemas/mitre-attack-techniques.json` with a deterministic
// serialization (`JSON.stringify(rows, null, 2) + "\n"`).
//
// Reproducibility: two runs against the same pin produce byte-identical
// output. Refresh PRs therefore show a minimal diff focused on the
// upstream content change.
//
// Scope: Enterprise bundle only. The aimer threat-detection scope is
// Enterprise today; Mobile and ICS bundles are intentionally excluded
// and would land as a separate follow-up. See `docs/SCHEMAS.md` for
// the full refresh procedure.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const REPO_ROOT = resolve(__dirname, "..");
const VERSION_PATH = join(REPO_ROOT, "schemas/mitre-attack.version");
const OUTPUT_PATH = join(REPO_ROOT, "schemas/mitre-attack-techniques.json");

// Matches `docs/SCHEMAS.md` "MITRE version pin format". Either:
//   - a MITRE-style tag (`v19.1`, `19.1`, optionally with patch
//     `v19.1.0`)
//   - a git commit SHA on mitre-attack/attack-stix-data (7-40 hex)
//
// Diverges from `schemas/aimer.version`'s regex: MITRE tags are
// two-component (`vXX.Y`), aimer requires three. Documented in
// `docs/SCHEMAS.md`.
const VERSION_RE = /^v?\d+\.\d+(\.\d+)?$|^[0-9a-f]{7,40}$/;
const SEMVER_TAG_RE = /^v?\d+\.\d+(\.\d+)?$/;
const SHA_RE = /^[0-9a-f]{7,40}$/;
const BUNDLE_FILE_RE = /^enterprise-attack-(\d+)\.(\d+)(?:\.(\d+))?\.json$/;

interface StixObject {
  type?: string;
  name?: string;
  revoked?: boolean;
  x_mitre_deprecated?: boolean;
  external_references?: Array<{
    source_name?: string;
    external_id?: string;
  }>;
}

interface StixBundle {
  objects?: StixObject[];
}

interface TechniqueRow {
  id: string;
  name: string;
}

function readPin(): string {
  const raw = readFileSync(VERSION_PATH, "utf-8");
  const lines = raw.split("\n").filter((l) => l.trim().length > 0);
  if (lines.length !== 1) {
    throw new Error(
      `mitre-attack.version must contain exactly one non-empty line, got ${lines.length}`,
    );
  }
  const pin = lines[0].trim();
  if (!VERSION_RE.test(pin)) {
    throw new Error(
      `mitre-attack.version value ${JSON.stringify(pin)} does not match ${VERSION_RE}`,
    );
  }
  return pin;
}

/**
 * MITRE's Git tags are always `v`-prefixed (`v19.1`); the bundle
 * filename is always `v`-stripped (`enterprise-attack-19.1.json`).
 * Normalize a pin into both forms.
 */
function tagPinToRefAndBundle(pin: string): {
  ref: string;
  bundleFile: string;
} {
  const stripped = pin.startsWith("v") ? pin.slice(1) : pin;
  return {
    ref: `v${stripped}`,
    bundleFile: `enterprise-attack-${stripped}.json`,
  };
}

function compareBundleFiles(a: string, b: string): number {
  const ma = BUNDLE_FILE_RE.exec(a);
  const mb = BUNDLE_FILE_RE.exec(b);
  if (!ma || !mb) return a.localeCompare(b);
  for (let i = 1; i <= 3; i++) {
    const na = Number(ma[i] ?? "0");
    const nb = Number(mb[i] ?? "0");
    if (na !== nb) return na - nb;
  }
  return 0;
}

async function ghFetch(path: string): Promise<unknown> {
  const url = `https://api.github.com${path}`;
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "aimer-web-mitre-vendor",
  };
  if (process.env.GITHUB_TOKEN) {
    headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  }
  const res = await fetch(url, { headers });
  if (!res.ok) {
    throw new Error(
      `GitHub API ${path} failed: ${res.status} ${res.statusText}`,
    );
  }
  return res.json();
}

async function pickBundleFileForSha(sha: string): Promise<string> {
  const entries = (await ghFetch(
    `/repos/mitre-attack/attack-stix-data/contents/enterprise-attack?ref=${sha}`,
  )) as Array<{ name?: string; type?: string }>;
  const candidates: string[] = [];
  for (const entry of entries) {
    if (entry.type !== "file" || !entry.name) continue;
    if (BUNDLE_FILE_RE.test(entry.name)) candidates.push(entry.name);
  }
  if (candidates.length === 0) {
    throw new Error(
      `no enterprise-attack-*.json bundles found in tree at SHA ${sha}`,
    );
  }
  candidates.sort(compareBundleFiles);
  return candidates[candidates.length - 1];
}

async function fetchBundle(
  ref: string,
  bundleFile: string,
): Promise<StixBundle> {
  const url = `https://raw.githubusercontent.com/mitre-attack/attack-stix-data/${ref}/enterprise-attack/${bundleFile}`;
  const res = await fetch(url, {
    headers: { "User-Agent": "aimer-web-mitre-vendor" },
  });
  if (!res.ok) {
    throw new Error(`fetch ${url} failed: ${res.status} ${res.statusText}`);
  }
  return (await res.json()) as StixBundle;
}

function extractTechniques(bundle: StixBundle): TechniqueRow[] {
  const rows: TechniqueRow[] = [];
  for (const obj of bundle.objects ?? []) {
    if (obj.type !== "attack-pattern") continue;
    // Exclude revoked and deprecated entries: MITRE itself no longer
    // recognizes these IDs, so accepting an LLM tag for one would
    // defeat the validation guarantee.
    if (obj.revoked === true) continue;
    if (obj.x_mitre_deprecated === true) continue;
    const ext = obj.external_references?.find(
      (ref) => ref.source_name === "mitre-attack",
    );
    const id = ext?.external_id;
    const name = obj.name;
    if (!id || !name) continue;
    rows.push({ id, name });
  }
  rows.sort((a, b) => a.id.localeCompare(b.id));
  return rows;
}

async function main(): Promise<void> {
  const pin = readPin();

  let ref: string;
  let bundleFile: string;
  if (SEMVER_TAG_RE.test(pin)) {
    ({ ref, bundleFile } = tagPinToRefAndBundle(pin));
  } else if (SHA_RE.test(pin)) {
    ref = pin;
    bundleFile = await pickBundleFileForSha(pin);
  } else {
    throw new Error(
      `unreachable: pin ${pin} matched neither tag nor SHA shape`,
    );
  }

  console.log(`mitre-attack-vendor: ref=${ref} bundle=${bundleFile}`);
  const bundle = await fetchBundle(ref, bundleFile);
  const rows = extractTechniques(bundle);
  if (rows.length === 0) {
    throw new Error("extracted zero techniques — bundle shape regression?");
  }
  const serialized = `${JSON.stringify(rows, null, 2)}\n`;
  writeFileSync(OUTPUT_PATH, serialized, "utf-8");
  console.log(
    `mitre-attack-vendor: wrote ${rows.length} techniques to ${OUTPUT_PATH}`,
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
