// RFC 0005 — FIRST EPSS CVE source (#611). Exploit-prediction score + percentile.
//
// Fetches the FIRST EPSS daily bulk CSV (keyless, free public grant). The
// published artifact is gzip-compressed (`epss_scores-current.csv.gz`), so the
// engine decompresses before parsing (`gzip: true`). The CSV leads with a
// `#model_version:...,score_date:...` comment line, then a `cve,epss,percentile`
// header, then one row per CVE. Also feeds the landscape's high-EPSS signal.

import type { CveParseResult, CveSnapshotInsertRow } from "./registry";
import { ONE_DAY_MS, registerCveSource } from "./registry";

/** FIRST EPSS current-scores bulk CSV (gzip, keyless). */
const EPSS_URL = "https://epss.cyentia.com/epss_scores-current.csv.gz";

/**
 * Parse the FIRST EPSS CSV into snapshot rows. The leading `#…` comment line
 * and the `cve,epss,percentile` header are skipped; each data row contributes
 * `epssScore` + `epssPercentile`. A row with a non-numeric score/percentile or
 * a missing CVE id is skipped (robust to format drift), never fatal.
 */
export function parseEpss(content: string): CveParseResult {
  const rows: CveSnapshotInsertRow[] = [];
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const cols = line.split(",");
    if (cols.length < 3) continue;
    const cve = cols[0].trim();
    // Skip the header row.
    if (cve.toLowerCase() === "cve" || !/^CVE-/i.test(cve)) continue;
    const score = Number(cols[1]);
    const percentile = Number(cols[2]);
    if (!Number.isFinite(score) || !Number.isFinite(percentile)) continue;
    rows.push({ cve, epssScore: score, epssPercentile: percentile });
  }
  return { rows };
}

registerCveSource({
  id: "epss",
  label: "FIRST",
  maxAge: 7 * 24 * 60 * 60 * 1000,
  fetch: {
    url: EPSS_URL,
    cadenceFloorMs: ONE_DAY_MS,
    gzip: true,
  },
  parse: parseEpss,
});
