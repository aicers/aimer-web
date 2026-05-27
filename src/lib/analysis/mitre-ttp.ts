// MITRE ATT&CK TTP tag validator.
//
// Server-only: this module reads the vendored JSON at
// `schemas/mitre-attack-techniques.json` via `readFileSync` at module
// init. It must not be imported from edge route handlers or client
// code — `import "server-only"` makes an accidental client import fail
// at build, not at runtime. Tests under `__tests__/` mock the
// `server-only` sentinel.
//
// The vendored knowledge base is sourced from MITRE's STIX 2.1 bundle.
// The version pin lives at `schemas/mitre-attack.version` and the
// refresh procedure is documented in `docs/SCHEMAS.md`.

import "server-only";

import { readFileSync } from "node:fs";
import { join } from "node:path";

const TECHNIQUES_PATH = join(
  process.cwd(),
  "schemas/mitre-attack-techniques.json",
);
const VERSION_PATH = join(process.cwd(), "schemas/mitre-attack.version");

/**
 * The vendored MITRE ATT&CK release pin as written in
 * `schemas/mitre-attack.version`. Read once at module init so audit
 * payloads carry a consistent value for the lifetime of the process.
 */
export const MITRE_VENDOR_VERSION: string = readFileSync(
  VERSION_PATH,
  "utf-8",
).trim();

// Sub-techniques use a three-digit suffix (e.g. `T1110.001`); top-level
// techniques are four digits (e.g. `T1110`). Anything else is rejected
// before the set lookup so an obvious typo surfaces as `invalid_format`
// rather than the slightly less specific `not_in_vendored_mitre`.
const TTP_ID_RE = /^T[0-9]{4}(\.[0-9]{3})?$/;

interface TechniqueRow {
  id: string;
  name: string;
}

function loadTechniques(): {
  ids: Set<string>;
  names: Map<string, string>;
} {
  const raw = readFileSync(TECHNIQUES_PATH, "utf-8");
  const rows = JSON.parse(raw) as TechniqueRow[];
  const ids = new Set<string>();
  const names = new Map<string, string>();
  for (const row of rows) {
    if (typeof row.id === "string") {
      ids.add(row.id);
      if (typeof row.name === "string") names.set(row.id, row.name);
    }
  }
  return { ids, names };
}

// Module-level singleton; the set / map are never exposed externally, so
// `Object.freeze` would be misleading (it does not block Set mutation)
// and module encapsulation is the actual guarantee.
const { ids: VENDORED_IDS, names: VENDORED_NAMES } = loadTechniques();

export type DroppedReason = "not_in_vendored_mitre" | "invalid_format";

export interface ValidateTtpTagsResult {
  valid: string[];
  dropped: Array<{ id: string; reason: DroppedReason }>;
}

/**
 * Filter LLM-returned MITRE ATT&CK technique IDs against the vendored
 * knowledge base. Returns both kept and dropped IDs so the caller can
 * audit why the LLM's output diverged.
 *
 * The `valid` array preserves input order. The audit log payload that
 * consumes this output relies on the deterministic ordering.
 */
export function validateTtpTags(raw: readonly string[]): ValidateTtpTagsResult {
  const valid: string[] = [];
  const dropped: Array<{ id: string; reason: DroppedReason }> = [];
  for (const id of raw) {
    if (!TTP_ID_RE.test(id)) {
      dropped.push({ id, reason: "invalid_format" });
      continue;
    }
    if (!VENDORED_IDS.has(id)) {
      dropped.push({ id, reason: "not_in_vendored_mitre" });
      continue;
    }
    valid.push(id);
  }
  return { valid, dropped };
}

/**
 * Resolve a MITRE ATT&CK technique ID to its human-readable name from
 * the same vendored knowledge base `validateTtpTags` consults. Returns
 * `null` when the ID is not present (legacy rows pre-dating a vendor
 * refresh, operator-side manual edits, on-disk corruption). Case-
 * sensitive — IDs are uppercase `T####(.###)?`.
 */
export function lookupTtpName(id: string): string | null {
  return VENDORED_NAMES.get(id) ?? null;
}
