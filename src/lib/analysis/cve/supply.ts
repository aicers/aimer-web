// RFC 0005 — CVE supply helper for the analysis write paths.
//
// Wraps the gating (feature flag + #498 deployment ordering), catalog
// resolution, landscape building (priming), and post-analysis validation
// + status computation behind one server-only seam, so `story-worker.ts`
// and `run-analyze-flow.ts` stay readable and the whole path is
// injectable in tests via a `CveSupply` override.
//
// When the feature is OFF (the default), `resolveCveWrite` writes
// `cve_refs = []` and `cve_status = NULL` (the "feature not active" render
// state), and the landscape builders return empty — so the caller uses
// the pre-#498-safe `AnalyzeEvent` / `AnalyzeStory` operations and sends
// no `cveRefs` selection or `cveLandscape` argument.

import "server-only";

import type { CveCatalog, CveSourceId, CveStatus } from "./catalog";
import {
  getCveCatalog,
  isCveEnrichmentEnabled,
  selectEnabledCveSources,
} from "./config";
import {
  buildEventLandscapeEntries,
  buildStoryLandscapeFacts,
  restrictLandscapeToEnabledSources,
  selectEventLandscape,
  selectStoryLandscape,
} from "./landscape";
import { type DroppedCveRef, validateCveRefs } from "./validate";

/** Per-customer/group scope passed to the F2 source-selection seam. */
export interface CveScope {
  customerId?: string;
  groupId?: string;
}

/**
 * Resolved CVE supply for one analysis run. `enabled: false` is the
 * gated-off state (use the pre-#498 operations; write `[]` / NULL).
 */
export type CveSupply =
  | { enabled: false }
  | {
      enabled: true;
      catalog: CveCatalog;
      enabledSources: Set<CveSourceId>;
    };

/** What `resolveCveWrite` returns for the result-row INSERT. */
export interface CveWrite {
  /** JSON of the enriched, validated `CveRecord[]` (or `[]`). */
  cveRefsJson: string;
  /** The `cve_status` enum, or `null` when the CVE path did not run. */
  cveStatus: string | null;
  /** Dropped refs + reasons, for audit logging. */
  dropped: DroppedCveRef[];
}

/** Story priming result: the facts to supply + whether priming degraded. */
export interface StorySupply {
  /** Verify-me one-liner facts for the `enrichmentFacts` channel. */
  facts: string[];
  /**
   * True when landscape generation threw, so no candidate context was
   * supplied. The caller threads this into {@link resolveCveWrite} so a
   * zero-CVE result from a run with degraded priming is recorded as an
   * unverified absence (`unknown`), not a confident no-CVE (`complete`).
   */
  primingDegraded: boolean;
}

/** Event priming result: the `cveLandscape` entries + the degraded flag. */
export interface EventSupply {
  /** `[{ cve, description }]` for the `cveLandscape` arg. */
  entries: Array<{ cve: string; description: string }>;
  /** See {@link StorySupply.primingDegraded}. */
  primingDegraded: boolean;
}

/**
 * The default supply, read from config. Resolves the catalog only when
 * the feature is enabled (so a disabled deployment never reads the
 * vendored fixture).
 */
export function defaultCveSupply(scope?: CveScope): CveSupply {
  if (!isCveEnrichmentEnabled()) return { enabled: false };
  return {
    enabled: true,
    catalog: getCveCatalog(),
    enabledSources: selectEnabledCveSources(scope),
  };
}

/**
 * Story priming facts (verify-me one-liners). `facts` is `[]` when gated
 * off; `primingDegraded` is true when a `landscape()` throw meant no
 * candidate context could be supplied.
 */
export async function buildStorySupplyFacts(
  supply: CveSupply,
  now: string,
): Promise<StorySupply> {
  if (!supply.enabled) return { facts: [], primingDegraded: false };
  // Priming is best-effort: a DB-backed catalog query that throws must
  // degrade the CVE portion, never fail the whole analysis (RFC 0005
  // "could not verify" stance). A thrown landscape yields no candidate
  // context — the analysis proceeds without priming, but the degradation is
  // reported so the write path records the no-CVE result as unverified.
  let records: Awaited<ReturnType<CveCatalog["landscape"]>>;
  try {
    records = await supply.catalog.landscape();
  } catch (err) {
    logCveDegradation("story landscape", err);
    return { facts: [], primingDegraded: true };
  }
  const facts = buildStoryLandscapeFacts(
    selectStoryLandscape(
      restrictLandscapeToEnabledSources(records, supply.enabledSources),
      { now },
    ),
  );
  return { facts, primingDegraded: false };
}

/**
 * Event priming entries (KEV-only slice). `entries` is `[]` when gated
 * off; `primingDegraded` is true when a `landscape()` throw meant no
 * candidate context could be supplied.
 */
export async function buildEventSupplyEntries(
  supply: CveSupply,
  now: string,
): Promise<EventSupply> {
  if (!supply.enabled) return { entries: [], primingDegraded: false };
  // Same best-effort degradation as the story path: a thrown landscape
  // sends an empty `cveLandscape` arg rather than failing the analysis, and
  // reports the degradation so the no-CVE result is recorded as unverified.
  let records: Awaited<ReturnType<CveCatalog["landscape"]>>;
  try {
    records = await supply.catalog.landscape();
  } catch (err) {
    logCveDegradation("event landscape", err);
    return { entries: [], primingDegraded: true };
  }
  const entries = buildEventLandscapeEntries(
    selectEventLandscape(
      restrictLandscapeToEnabledSources(records, supply.enabledSources),
      { now },
    ),
  );
  return { entries, primingDegraded: false };
}

/**
 * Validate + enrich the LLM's `cveRefs` and compute the status for the
 * result-row INSERT. When gated off, returns the inactive state
 * (`[]` / NULL) regardless of `rawCveRefs`.
 *
 * A catalog/procedure that THROWS (e.g. a DB-backed snapshot query
 * failure) is treated as a degraded check, not an analysis failure: the
 * row is still written with `cve_refs = []` and a non-null degraded
 * `cve_status` of `unknown`, and every emitted ref is reported as
 * `could_not_consult` for audit. This is the exact "couldn't check"
 * branch the render's could-not-verify state gates on — an unverified
 * absence, never a confident no-CVE result.
 *
 * `primingDegraded` carries the same "couldn't check" signal from the
 * EARLIER priming step: if landscape generation threw, the configured
 * candidate context was never supplied, so a zero-CVE result is unverified
 * even when validation itself ran cleanly. RFC 0005 makes the confident
 * no-CVE state conditional on the whole pipeline — including priming
 * "where configured" — actually running, so a priming throw demotes an
 * otherwise-authoritative status to `unknown` (see {@link foldPrimingDegradation}).
 */
export async function resolveCveWrite(
  supply: CveSupply,
  rawCveRefs: readonly string[],
  checkedAt: string,
  primingDegraded = false,
): Promise<CveWrite> {
  if (!supply.enabled) {
    return { cveRefsJson: "[]", cveStatus: null, dropped: [] };
  }
  try {
    const result = await validateCveRefs(rawCveRefs, supply.catalog, {
      enabledSources: supply.enabledSources,
      checkedAt,
    });
    return {
      cveRefsJson: JSON.stringify(result.valid),
      cveStatus: foldPrimingDegradation(result.status.status, primingDegraded),
      dropped: result.dropped,
    };
  } catch (err) {
    logCveDegradation("validation", err);
    return {
      cveRefsJson: "[]",
      cveStatus: "unknown",
      dropped: rawCveRefs.map((id) => ({
        id,
        reason: "could_not_consult" as const,
      })),
    };
  }
}

/**
 * Fold a priming-landscape degradation into the validation status. A
 * thrown landscape means the configured candidate context was never
 * supplied, so a zero-CVE result is unverified rather than a confirmed
 * absence: an authoritative `complete`/`partial` is demoted to `unknown`
 * (which the render maps to the "could not verify" state, never the
 * confident no-CVE caution narrative). An already-degraded `unknown`/
 * `stale` keeps its more specific marker. A clean run (`!degraded`) is
 * returned verbatim.
 */
function foldPrimingDegradation(
  status: CveStatus,
  degraded: boolean,
): CveStatus {
  if (!degraded) return status;
  return status === "complete" || status === "partial" ? "unknown" : status;
}

/**
 * A thrown catalog/procedure failure is a degraded CVE check, not a fatal
 * analysis error — surface it for observability while the caller proceeds
 * with the degraded result above.
 */
function logCveDegradation(stage: string, err: unknown): void {
  console.error(
    `CVE enrichment degraded (${stage}):`,
    err instanceof Error ? err.message : String(err),
  );
}
