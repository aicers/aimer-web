// RFC 0005 — CVE feature gating, source selection (F2 seam), and the
// default vendored catalog resolver.
//
// Server-only: reads the vendored fixture JSON at module use. Mirrors the
// `mitre-ttp.ts` vendoring pattern (pinned JSON + a `*.version` pin).
//
// Deployment ordering (RFC 0005): the leaf `cveRefs` selection, the
// `cveLandscape` argument, AND the periodic-report `cveRefs` /
// `aggregateCveRefs` input fields (`aimer#499`) are all gated on the CVE
// backend being deployed to every environment aimer-web talks to.
// `CVE_ENRICHMENT_ENABLED` is that gate: when off (the default), the
// worker/flow use the pre-#498-safe `AnalyzeEvent` / `AnalyzeStory`
// operations (no `cveRefs`, no `cveLandscape`), the periodic-report mutation
// omits the `cveRefs` / `aggregateCveRefs` input fields (a pre-#499 backend
// rejects unknown input fields even when empty — see `gateCveInputFields`),
// `cve_refs` is written `[]`, and `cve_status` is left NULL (the "feature
// not active" render state). Flip it on only once #498 AND #499 are deployed
// everywhere AND a real CVE catalog is supplied.

import "server-only";

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getFeedPool } from "@/lib/db/client";
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
import { PgCveCatalog } from "./pg-catalog";
// Importing the barrel runs each CVE source's `registerCveSource` side effect,
// so the registry is populated before `cveSourceCatalog` enumerates it (the
// same pattern `ti-sources.ts` uses for the IOC registry).
import "./sources";
import { allCveSourceDescriptors } from "./sources/registry";

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

// --- F2 enumerable seam: CVE sources as a distinct selection kind (#612) ---
//
// #598 surfaces the IOC TI sources to the per-customer/group selection model
// by mapping `allTiSourceDescriptors()` to a public `TiSourceCatalogEntry`
// DTO keyed on `sourcePolicyId`. CVE sources must reach the SAME selection
// model, but they are a SEPARATE namespace and a SEPARATE consumer: CVE ids
// (`nvd`/`kev`/`epss`) drive `computeCveStatus` via `selectEnabledCveSources`,
// NOT `buildLocalFeedDispatcher` via the IOC `sourcePolicyId` allowlist. So
// this seam exposes CVE sources as a DISTINCT source kind (`kind: "cve"`,
// keyed on `sourceId`) — they must never be appended to #598's IOC
// `sourcePolicyId` allowlist, or the two enrichment pipelines would be
// conflated.
//
// COORDINATION NOTE — this issue (#612) ships the ENUMERABLE seam only. The
// kind-discriminated per-customer/group *storage* wiring (a CVE kind in
// #598's `subject_ti_sources` row / catalog DTO / management routes, or a
// union those consume) is a deferred follow-up AFTER #598 lands. Until then,
// `selectEnabledCveSources` (default all-enabled, above) stays the LIVE gating
// authority for what `computeCveStatus` considers — CVE selection is NOT
// silently ungated. `cveSourceCatalog` below reads through that seam, so once
// real per-subject CVE selection is wired into `selectEnabledCveSources`, this
// catalog DTO reflects it without further change.

/**
 * One selectable CVE source as exposed to the per-customer/group selection
 * model — the CVE analogue of #598's `TiSourceCatalogEntry`. Kept a DISTINCT
 * source kind (`kind: "cve"`, keyed on the closed-union `sourceId`) so CVE ids
 * never enter the IOC `sourcePolicyId` allowlist. A deliberately NARROW DTO:
 * only the id/label/enabled a toggle UI needs, never the descriptor internals
 * (`fetch`/`parse`/`maxAge`), which describe the ingestion engine.
 */
export interface CveSourceCatalogEntry {
  /** Discriminator marking a CVE source, distinct from the IOC source kind. */
  kind: "cve";
  /** Closed-union CVE source id (`nvd` | `kev` | `epss`) — NOT a `sourcePolicyId`. */
  sourceId: CveSourceId;
  /** Human-facing citation label (`CVE_SOURCE_LABELS[sourceId]`). */
  label: string;
  /** Whether this source is enabled under the resolved F2 selection. */
  enabled: boolean;
}

/**
 * Surface the registered CVE sources (#611's `allCveSourceDescriptors()`) to
 * the selection model as the CVE catalog DTO, each entry flagged `enabled`
 * against `selectEnabledCveSources(scope)` (default all-enabled). Mirrors how
 * #598's `toCatalogDto` maps the IOC registry to `TiSourceCatalogEntry`, but
 * as a distinct kind keyed on `sourceId` — it never leaks a CVE id into the
 * IOC `sourcePolicyId` namespace. Enumerated in `ALL_CVE_SOURCES` citation
 * order (the accessor's contract), so the DTO order is deterministic.
 */
export function cveSourceCatalog(scope?: {
  customerId?: string;
  groupId?: string;
}): CveSourceCatalogEntry[] {
  const enabled = selectEnabledCveSources(scope);
  return allCveSourceDescriptors().map((descriptor) => ({
    kind: "cve" as const,
    sourceId: descriptor.id,
    label: descriptor.label,
    enabled: enabled.has(descriptor.id),
  }));
}

// --- DB-backed catalog + the retained vendored fixture (for tests) --------

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

/**
 * Load the vendored fixture catalog (the pinned `schemas/cve-fixture.json`),
 * treated as a live snapshot: all core sources available, freshness stamped
 * at load. Retained for tests / offline use after the DB-backed catalog
 * became the production default — NOT wired into `getCveCatalog`.
 */
export function getFixtureCveCatalog(): CveCatalog {
  const raw = readFileSync(FIXTURE_PATH, "utf-8");
  const parsed = JSON.parse(raw) as VendoredFixture;
  const config: FixtureCatalogConfig = {
    sources: allAvailableSources(new Date().toISOString()),
    records: parsed.records ?? {},
    landscape: parsed.landscape ?? [],
  };
  return new FixtureCveCatalog(config);
}

let cachedCatalog: CveCatalog | null = null;

/**
 * The default CVE catalog: the DB-backed `PgCveCatalog` over the feed DB's
 * CVE snapshot (#601). Until ingestion (#611) warms the snapshot it is empty,
 * but with `CVE_ENRICHMENT_ENABLED` off (the default) the whole CVE path is
 * inert — wiring this here does not enable the feature. The fixture catalog
 * (`getFixtureCveCatalog`) is retained for tests.
 */
export function getCveCatalog(): CveCatalog {
  if (cachedCatalog !== null) return cachedCatalog;
  cachedCatalog = new PgCveCatalog(getFeedPool());
  return cachedCatalog;
}
