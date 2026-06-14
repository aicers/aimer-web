// RFC 0005 — CVE coverage status (the IOC `computeCoverage` analogue).
//
// `computeCveStatus` collapses the per-source availability/freshness the
// catalog reports into the same `complete | partial | unknown | stale`
// enum the IOC layer uses (`src/lib/analysis/enrichment/coverage.ts`), so
// a zero CVE result is never silently ambiguous between "checked, none
// apply" (`complete`) and "couldn't check" (`unknown`/`stale`).
//
// Semantics (RFC 0005 Scope 3a):
//   - `complete` = validation ran against available/fresh catalogs, so a
//     zero result is authoritative.
//   - `stale`    = a catalog answered but its snapshot is past `maxAge`.
//   - `unknown`  = a catalog was unavailable (could-not-consult).
//   - `partial`  = an enabled source had no outcome at all.
// Intentional gating is NOT a degradation: only sources in `enabled`
// (the F2 selection) are considered, so a disabled source — or the
// KEV-only event slice — never marks `unknown`.

import type { CveSourceId, CveSourceOutcome, CveStatus } from "./catalog";

/**
 * Default freshness window for a CVE snapshot. NVD/KEV/EPSS publish at
 * least daily; a snapshot older than this is treated as `stale` so a
 * zero result against an aged catalog is surfaced as degraded rather than
 * authoritative. Tunable via `CVE_SOURCE_MAX_AGE_MS`.
 */
const DEFAULT_CVE_SOURCE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

function resolveMaxAge(): number {
  const raw = process.env.CVE_SOURCE_MAX_AGE_MS;
  if (!raw) return DEFAULT_CVE_SOURCE_MAX_AGE_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0
    ? Math.floor(n)
    : DEFAULT_CVE_SOURCE_MAX_AGE_MS;
}

export const CVE_SOURCE_MAX_AGE_MS = resolveMaxAge();

type SourceState = "fresh" | "stale" | "unavailable" | "not_attempted";

function classify(
  outcome: CveSourceOutcome | undefined,
  maxAgeMs: number,
  checkedAtMs: number,
): SourceState {
  if (outcome === undefined) return "not_attempted";
  if (outcome.answered !== true) return "unavailable";
  // Answered. Freshness must be proven, not assumed — a missing or
  // unparseable `sourceUpdatedAt` cannot satisfy the freshness predicate,
  // so the source is `stale` (answered-but-not-fresh), never `fresh`.
  // This preserves the false-clean distinction (a zero result against an
  // unvouched snapshot is never `complete`). Mirrors `coverage.ts`.
  if (outcome.sourceUpdatedAt === undefined) return "stale";
  const updatedMs = Date.parse(outcome.sourceUpdatedAt);
  if (Number.isNaN(updatedMs)) return "stale";
  return checkedAtMs - updatedMs > maxAgeMs ? "stale" : "fresh";
}

/** The collapsed status plus the raw counts that fed it (debug/alerting). */
export interface CveStatusReport {
  status: CveStatus;
  expectedCount: number;
  answeredCount: number;
  freshCount: number;
  staleCount: number;
  unavailableCount: number;
  notAttemptedCount: number;
}

/**
 * Compute CVE coverage status from the per-source outcomes, considering
 * ONLY the `enabled` (F2-selected) sources. Most-severe-wins precedence
 * mirrors `computeCoverage`:
 *   1. any unavailable        → `unknown`
 *   2. else any stale         → `stale`
 *   3. else answered < enabled → `partial`
 *   4. else all fresh         → `complete`
 */
export function computeCveStatus(
  outcomes: readonly CveSourceOutcome[],
  enabled: ReadonlySet<CveSourceId>,
  checkedAt: string,
  maxAgeMs: number = CVE_SOURCE_MAX_AGE_MS,
): CveStatusReport {
  const checkedAtMs = Date.parse(checkedAt);
  const byId = new Map<CveSourceId, CveSourceOutcome>();
  for (const o of outcomes) {
    const existing = byId.get(o.source);
    // Prefer an answered outcome if a source appears twice.
    if (!existing || (!existing.answered && o.answered)) byId.set(o.source, o);
  }

  let freshCount = 0;
  let staleCount = 0;
  let unavailableCount = 0;
  let notAttemptedCount = 0;
  for (const source of enabled) {
    const state = classify(byId.get(source), maxAgeMs, checkedAtMs);
    if (state === "fresh") freshCount += 1;
    else if (state === "stale") staleCount += 1;
    else if (state === "unavailable") unavailableCount += 1;
    else notAttemptedCount += 1;
  }

  const expectedCount = enabled.size;
  const answeredCount = freshCount + staleCount;

  let status: CveStatus;
  if (unavailableCount > 0) status = "unknown";
  else if (staleCount > 0) status = "stale";
  else if (answeredCount < expectedCount) status = "partial";
  else status = "complete";

  return {
    status,
    expectedCount,
    answeredCount,
    freshCount,
    staleCount,
    unavailableCount,
    notAttemptedCount,
  };
}
