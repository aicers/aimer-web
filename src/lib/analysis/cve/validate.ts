// RFC 0005 — CVE ref validation + enrichment (the `validateTtpTags`
// analogue, RFC 0005 Scope 2).
//
// `validateCveRefs` takes the LLM-emitted `cveRefs` (backend-guaranteed
// well-formed) and a `CveCatalog`, and:
//   - normalizes each ref (canonicalization, NOT the precision gate);
//   - validates EXISTENCE against the catalog — a well-formed but
//     non-existent id (`CVE-2099-99999`) is the hallucination this drops;
//   - attaches the enrichment payload (CVSS / KEV / EPSS / summary /
//     in-the-wild + validating sources) to survivors;
//   - returns dropped refs WITH reasons for audit logging, distinguishing
//     `not_in_catalog` (genuinely hallucinated — the catalog was consulted
//     and the id isn't there) from `could_not_consult` (a catalog was
//     unavailable/stale, so the id is UNCONFIRMED, not proven invalid);
//   - derives the CVE coverage `status` from the catalog's per-source
//     availability (`computeCveStatus`), so a zero result is never
//     ambiguous between "checked, none apply" and "couldn't check".

import {
  ALL_CVE_SOURCES,
  type CveCatalog,
  type CveRecord,
  type CveSourceId,
} from "./catalog";
import { normalizeCve } from "./normalize";
import { type CveStatusReport, computeCveStatus } from "./status";

export type DroppedCveReason =
  // Syntactically malformed (belt-and-suspenders; the backend guarantees
  // form, so this should never fire in steady state).
  | "invalid_format"
  // Well-formed and the catalog was consulted, but the id is absent — the
  // hallucination case. Does NOT degrade status.
  | "not_in_catalog"
  // Well-formed but a catalog was unavailable/stale, so existence could
  // not be confirmed — UNCONFIRMED, not proven invalid. Pushes `unknown`.
  | "could_not_consult"
  // Well-formed and present, but every source that carries the id is
  // INTENTIONALLY gated off by the F2 selection — so it cannot be cited
  // and is dropped. Intentional gating is not a degradation, so this does
  // NOT push `unknown` (the status path ignores F2-disabled sources).
  | "source_disabled";

export interface DroppedCveRef {
  /** The raw input ref, preserved verbatim for the audit trail. */
  id: string;
  reason: DroppedCveReason;
}

export interface ValidateCveRefsResult {
  /** Enriched, catalog-validated CVE records (input order preserved). */
  valid: CveRecord[];
  /** Refs dropped, with reasons, for audit logging. */
  dropped: DroppedCveRef[];
  /** CVE coverage status (Scope 3a) — drives the no-CVE render state. */
  status: CveStatusReport;
}

export interface ValidateCveRefsOptions {
  /**
   * The F2-selected source set to consult (default: all core sources).
   * A source omitted here is intentionally gated off, so it never marks
   * the status `unknown` — only an actual availability/freshness failure
   * of an ENABLED source does.
   */
  enabledSources?: ReadonlySet<CveSourceId>;
  /** The instant validation ran (ISO); drives freshness. */
  checkedAt: string;
}

/**
 * Validate + enrich LLM-emitted CVE refs against a catalog. Async because
 * the real (DB-snapshot) catalog issues queries.
 */
export async function validateCveRefs(
  raw: readonly string[],
  catalog: CveCatalog,
  options: ValidateCveRefsOptions,
): Promise<ValidateCveRefsResult> {
  const enabled =
    options.enabledSources ?? new Set<CveSourceId>(ALL_CVE_SOURCES);

  // Status is computed once from the catalog's per-source availability,
  // independent of any single ref. A missing ref's drop reason is then
  // derived from this status: if the (enabled) catalogs were all
  // available/fresh (`complete`), a miss is genuinely `not_in_catalog`;
  // otherwise existence could not be confirmed (`could_not_consult`).
  // This ties the drop reason to the same availability signal the status
  // reflects, exactly as Scope 3a requires.
  const outcomes = await catalog.sourceOutcomes();
  const status = computeCveStatus(outcomes, enabled, options.checkedAt);
  const consultedCompletely = status.status === "complete";

  const valid: CveRecord[] = [];
  const dropped: DroppedCveRef[] = [];
  const seen = new Set<string>();

  for (const ref of raw) {
    const canonical = normalizeCve(ref);
    if (canonical === null) {
      dropped.push({ id: ref, reason: "invalid_format" });
      continue;
    }
    // Dedup: a repeated canonical id is collapsed (first occurrence wins),
    // never validated or rendered twice.
    if (seen.has(canonical)) continue;
    seen.add(canonical);

    const record = await catalog.lookup(canonical);
    if (record !== null) {
      // Apply the F2 selection: strip facts from disabled sources so a
      // gated-off source never reaches the chips or its provenance. A
      // record left with no enabled-source backing is dropped (intentional
      // gating, distinct from a hallucination or a degraded check).
      const restricted = restrictToEnabledSources(record, enabled);
      if (restricted !== null) {
        valid.push(restricted);
      } else {
        dropped.push({ id: canonical, reason: "source_disabled" });
      }
      continue;
    }
    dropped.push({
      id: canonical,
      reason: consultedCompletely ? "not_in_catalog" : "could_not_consult",
    });
  }

  return { valid, dropped, status };
}

/**
 * Apply the F2 source selection to one catalog record: drop facts whose
 * source is disabled and re-derive the cited `sources`. Returns `null`
 * when no enabled source backs the record (so it must NOT be cited or
 * rendered). "Disabled" here means INTENTIONALLY gated off — orthogonal
 * to an unavailable/stale source, which the status path (not this filter)
 * reflects.
 */
function restrictToEnabledSources(
  record: CveRecord,
  enabled: ReadonlySet<CveSourceId>,
): CveRecord | null {
  const cvss =
    record.cvss && enabled.has(record.cvss.source) ? record.cvss : null;
  const kev = record.kev && enabled.has(record.kev.source) ? record.kev : null;
  const epss =
    record.epss && enabled.has(record.epss.source) ? record.epss : null;
  // summary is an NVD field, in-the-wild a KEV field — gate each on its
  // source so disabled-source context never leaks into the payload.
  const summary = enabled.has("nvd") ? record.summary : null;
  const inTheWild = enabled.has("kev") ? record.inTheWild : null;
  const sources = record.sources.filter((s) => enabled.has(s));
  const hasSignal =
    cvss !== null ||
    kev !== null ||
    epss !== null ||
    summary !== null ||
    inTheWild !== null;
  if (!hasSignal) return null;
  return { cve: record.cve, cvss, kev, epss, summary, inTheWild, sources };
}
