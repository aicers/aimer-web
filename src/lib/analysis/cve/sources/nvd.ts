// RFC 0005 — NVD CVE source (#611). Canonical CVSS base score + CWE.
//
// Bulk-sync via the NVD API 2.0 (`/rest/json/cves/2.0`), the RFC 0005 Resolved
// decision 4 path (NOT the legacy JSON data feeds). The API is paged
// (`resultsPerPage` ≤ 2000, `startIndex`) and rate-limited tightly — 5 req/30s
// keyless, 50 req/30s with an API key — so the engine rate-paces ~6 s between
// pages and the refresh runs DAILY + backlog-tolerant rather than as a burst.
//
// The API key is OPTIONAL: when set it is read from the `feed_source_secret`
// Transit envelope (key name `nvd`) and sent in the `apiKey` HEADER; when unset
// the source fetches keyless (just rate-paced slower). A very-recent CVE may
// lack CVSS metrics — that yields a row with `cvssScore: null` (the record
// falls back to the KEV/EPSS signal), never an error.

import type { CveParseResult, CveSnapshotInsertRow } from "./registry";
import { ONE_DAY_MS, registerCveSource } from "./registry";

/** `feed_source_secret.key_name` for the optional NVD API key. */
export const NVD_AUTH_KEY_NAME = "nvd";

/** NVD API 2.0 bulk endpoint. */
const NVD_API_URL = "https://services.nvd.nist.gov/rest/json/cves/2.0";

// --- NVD API 2.0 response shapes (only the fields we read) -----------------

interface NvdCvssData {
  baseScore?: number;
  vectorString?: string;
}

interface NvdMetric {
  // NVD tags each metric `Primary` (the authoritative NVD/CNA score) or
  // `Secondary`; prefer `Primary` so a secondary metric listed first does not
  // shadow the canonical base score.
  type?: string;
  cvssData?: NvdCvssData;
}

interface NvdWeaknessDescription {
  lang?: string;
  value?: string;
}

interface NvdCve {
  id?: string;
  published?: string;
  descriptions?: { lang?: string; value?: string }[];
  metrics?: {
    cvssMetricV40?: NvdMetric[];
    cvssMetricV31?: NvdMetric[];
    cvssMetricV30?: NvdMetric[];
    cvssMetricV2?: NvdMetric[];
  };
  weaknesses?: { description?: NvdWeaknessDescription[] }[];
}

interface NvdResponse {
  totalResults?: number;
  vulnerabilities?: { cve?: NvdCve }[];
}

/** First English description, else the first available, else null. */
function pickDescription(cve: NvdCve): string | null {
  const descs = cve.descriptions ?? [];
  const en = descs.find((d) => d.lang === "en" && typeof d.value === "string");
  const any = descs.find((d) => typeof d.value === "string");
  return en?.value ?? any?.value ?? null;
}

/** A metric whose `cvssData.baseScore` is a number, or null. */
function usableMetric(
  metric: NvdMetric | undefined,
): { score: number; vector: string | null } | null {
  const data = metric?.cvssData;
  if (data && typeof data.baseScore === "number") {
    return { score: data.baseScore, vector: data.vectorString ?? null };
  }
  return null;
}

/**
 * Preferred CVSS base score: newest version first (v4.0 → v3.1 → v3.0 → v2),
 * or null when none present. Within each version bucket a `Primary` metric (the
 * authoritative NVD/CNA score) wins over a `Secondary` one regardless of array
 * order; if no `Primary` is present, the first usable metric is used.
 */
function pickCvss(
  cve: NvdCve,
): { score: number; vector: string | null } | null {
  const metrics = cve.metrics;
  const series = [
    metrics?.cvssMetricV40,
    metrics?.cvssMetricV31,
    metrics?.cvssMetricV30,
    metrics?.cvssMetricV2,
  ];
  for (const list of series) {
    if (!list || list.length === 0) continue;
    const primary = usableMetric(list.find((m) => m.type === "Primary"));
    if (primary) return primary;
    for (const metric of list) {
      const usable = usableMetric(metric);
      if (usable) return usable;
    }
  }
  return null;
}

/** CWE ids from the weaknesses block, deduped; the `NVD-CWE-*` placeholders dropped. */
function pickCwe(cve: NvdCve): string[] | null {
  const out = new Set<string>();
  for (const weakness of cve.weaknesses ?? []) {
    for (const desc of weakness.description ?? []) {
      const value = desc.value;
      if (typeof value === "string" && /^CWE-\d+$/.test(value)) out.add(value);
    }
  }
  return out.size > 0 ? [...out] : null;
}

/**
 * Normalize an NVD publish timestamp to an ISO instant. NVD emits UTC without a
 * trailing `Z` (e.g. `2024-04-12T08:15:06.230`); append `Z` so the
 * `timestamptz` insert is unambiguous (the column drives landscape recency).
 */
function normalizePublished(value: string | undefined): string | null {
  if (typeof value !== "string" || value.length === 0) return null;
  return /[zZ]|[+-]\d{2}:?\d{2}$/.test(value) ? value : `${value}Z`;
}

/**
 * Parse one NVD API 2.0 response page into snapshot rows. Each `vulnerabilities`
 * entry becomes one row keyed by its CVE id; an entry missing an id is skipped.
 * A CVE without CVSS metrics still yields a row (`cvssScore: null`) so its
 * existence is recorded — the KEV/EPSS-signal fallback, never a dropped CVE.
 * `totalResults` is surfaced so the engine can page the full backlog.
 */
export function parseNvd(content: string): CveParseResult {
  const parsed = JSON.parse(content) as NvdResponse;
  const rows: CveSnapshotInsertRow[] = [];
  for (const entry of parsed.vulnerabilities ?? []) {
    const cve = entry.cve;
    if (!cve || typeof cve.id !== "string" || cve.id.length === 0) continue;
    const cvss = pickCvss(cve);
    rows.push({
      cve: cve.id,
      cvssScore: cvss?.score ?? null,
      cvssVector: cvss?.vector ?? null,
      cwe: pickCwe(cve),
      description: pickDescription(cve),
      publishedAt: normalizePublished(cve.published),
    });
  }
  return {
    rows,
    totalResults:
      typeof parsed.totalResults === "number"
        ? parsed.totalResults
        : rows.length,
  };
}

registerCveSource({
  id: "nvd",
  label: "NVD",
  maxAge: 7 * 24 * 60 * 60 * 1000,
  fetch: {
    url: NVD_API_URL,
    cadenceFloorMs: ONE_DAY_MS,
    authKeyName: NVD_AUTH_KEY_NAME,
    authKeyHeader: "apiKey",
    paging: {
      // NVD caps a page at 2000 results; ~6 s between pages keeps a keyless
      // sync under the 5-req/30 s limit (the daily window absorbs the backlog).
      resultsPerPage: 2000,
      interPageDelayMs: 6000,
    },
  },
  parse: parseNvd,
});
