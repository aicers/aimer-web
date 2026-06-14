// RFC 0005 — CVE feature gating, source selection (F2 seam), and the
// default vendored catalog resolver.
//
// Server-only: reads the vendored fixture JSON at module use. Mirrors the
// `mitre-ttp.ts` vendoring pattern (pinned JSON + a `*.version` pin).
//
// Deployment ordering (RFC 0005): BOTH the `cveRefs` selection AND the
// `cveLandscape` argument are gated on the #498 backend being deployed to
// every environment aimer-web talks to. `CVE_ENRICHMENT_ENABLED` is that
// gate: when off (the default), the worker/flow use the pre-#498-safe
// `AnalyzeEvent` / `AnalyzeStory` operations (no `cveRefs`, no
// `cveLandscape`), `cve_refs` is written `[]`, and `cve_status` is left
// NULL (the "feature not active" render state). Flip it on only once #498
// is deployed everywhere AND a real CVE catalog is supplied.

import "server-only";

import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ALL_CVE_SOURCES,
  type CveCatalog,
  type CveLandscapeRecord,
  type CveSourceId,
} from "./catalog";
import {
  allAvailableSources,
  type FixtureCatalogConfig,
  FixtureCveCatalog,
  type FixtureCveData,
} from "./fixture-catalog";

function envFlag(raw: string | undefined): boolean {
  if (!raw) return false;
  const v = raw.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

/**
 * Master gate for the CVE enrichment surface (validation + storage +
 * landscape + the `cveRefs`/`cveLandscape` operation variants). Off by
 * default — see the deployment-ordering note above.
 */
export const CVE_ENRICHMENT_ENABLED = envFlag(
  process.env.CVE_ENRICHMENT_ENABLED,
);

export function isCveEnrichmentEnabled(): boolean {
  return CVE_ENRICHMENT_ENABLED;
}

/**
 * F2 source-selection seam (RFC 0005 Scope 3a/5; default all-enabled).
 * The CVE source fan-out / F2 selection wires real per-customer/group
 * gating here; today it returns every core source. Critically, a source
 * disabled here is intentionally gated off, so it does NOT mark the CVE
 * status `unknown` (only an availability/freshness failure of an enabled
 * source does — see `computeCveStatus`).
 */
export function selectEnabledCveSources(_scope?: {
  customerId?: string;
  groupId?: string;
}): Set<CveSourceId> {
  return new Set<CveSourceId>(ALL_CVE_SOURCES);
}

// --- Vendored fixture catalog (default placeholder until the fan-out) -----

const FIXTURE_PATH = join(process.cwd(), "schemas/cve-fixture.json");
const VERSION_PATH = join(process.cwd(), "schemas/cve-fixture.version");

/** The vendored CVE fixture pin (audit/debug parity with MITRE). */
export const CVE_FIXTURE_VERSION: string = readFileSync(
  VERSION_PATH,
  "utf-8",
).trim();

interface VendoredFixture {
  records: Record<string, FixtureCveData>;
  landscape: CveLandscapeRecord[];
}

let cachedCatalog: CveCatalog | null = null;

/**
 * The default CVE catalog. Until the source fan-out ships a DB-backed
 * catalog, this is the vendored fixture treated as a live snapshot: all
 * core sources available, freshness stamped at load (the file is the
 * snapshot, so its currency is the load instant). The fan-out replaces
 * this resolver with the real NVD/KEV/EPSS-backed catalog against the
 * same `CveCatalog` interface.
 */
export function getCveCatalog(): CveCatalog {
  if (cachedCatalog !== null) return cachedCatalog;
  const raw = readFileSync(FIXTURE_PATH, "utf-8");
  const parsed = JSON.parse(raw) as VendoredFixture;
  const config: FixtureCatalogConfig = {
    sources: allAvailableSources(new Date().toISOString()),
    records: parsed.records ?? {},
    landscape: parsed.landscape ?? [],
  };
  cachedCatalog = new FixtureCveCatalog(config);
  return cachedCatalog;
}
