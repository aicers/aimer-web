// RFC 0005 — CISA KEV CVE source (#611). Known-exploited flag + dateAdded.
//
// Fetches the CISA "Known Exploited Vulnerabilities" JSON catalog (keyless,
// public domain). Every entry in the catalog is, by definition, known-exploited
// in the wild, so each row is stamped `kevKnownExploited: true` +
// `inTheWild: true`, carrying CISA's `dateAdded` (verbatim) and
// `shortDescription` (the source-local description the landscape uses for a
// KEV-only CVE). Also feeds the landscape's recent-KEV recency signal.

import type { CveParseResult, CveSnapshotInsertRow } from "./registry";
import { ONE_DAY_MS, registerCveSource } from "./registry";

/** CISA KEV catalog (JSON, keyless). */
const KEV_URL =
  "https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json";

interface KevEntry {
  cveID?: string;
  dateAdded?: string;
  shortDescription?: string;
}

interface KevCatalog {
  vulnerabilities?: KevEntry[];
}

/**
 * Parse the CISA KEV JSON catalog into snapshot rows. Each entry is a
 * known-exploited CVE → one row with `kevKnownExploited: true` and
 * `inTheWild: true`; an entry missing a `cveID` is skipped. KEV carries no
 * publish date, so `publishedAt` stays null (the landscape coalesces to
 * `kevDateAdded`).
 */
export function parseKev(content: string): CveParseResult {
  const parsed = JSON.parse(content) as KevCatalog;
  const rows: CveSnapshotInsertRow[] = [];
  for (const entry of parsed.vulnerabilities ?? []) {
    if (typeof entry.cveID !== "string" || entry.cveID.length === 0) continue;
    rows.push({
      cve: entry.cveID,
      kevKnownExploited: true,
      kevDateAdded: entry.dateAdded ?? null,
      inTheWild: true,
      description: entry.shortDescription ?? null,
    });
  }
  return { rows };
}

registerCveSource({
  id: "kev",
  label: "CISA",
  maxAge: 7 * 24 * 60 * 60 * 1000,
  fetch: {
    url: KEV_URL,
    cadenceFloorMs: ONE_DAY_MS,
  },
  parse: parseKev,
});
