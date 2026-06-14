// RFC 0003 / RFC 0005 — TI IOC evidence + feed-source citation view model
// (#591, the user-facing-surface consumer #589 carves out).
//
// Pure (no `server-only`, no I/O) so the server-component loaders and the
// chip/citation UI share ONE model, and the verdict / evidence-class state
// machines are unit-testable directly. The server loader
// (`ioc-evidence-loader.ts`) reads the `*_enrichment_state` /
// `*_ioc_evidence` rows, resolves the redaction de-map + source labels, and
// produces an {@link IocEnrichment}; the UI consumes it without re-deriving
// anything privacy- or DB-shaped.

/**
 * RFC 0003 §"Audit / evidence model" coverage status, mirrored on both the
 * enrichment-state row (the per-story/event verdict authority) and each
 * evidence row. `complete` = the floor was evaluated on full Tier-1
 * coverage; `unknown`/`stale`/`partial` = a source was down / a feed stale /
 * coverage partial, so a `known_ioc_hit = false` reflects incomplete coverage
 * rather than a confirmed clean miss. The canonical home for this type so the
 * loaders, the CVE mirror, and this surface all reference one definition.
 */
export type CoverageStatus = "complete" | "partial" | "unknown" | "stale";

/**
 * The three evidence classes (RFC 0003 amendment #589). Only
 * `floor_supporting` rows drove `known_ioc_hit`; the other two are
 * evidence-only context. Derived from `(hit_type, floor_eligible)` —
 * never persisted as its own column.
 */
export type IocEvidenceClass =
  | "floor_supporting"
  | "floor_ineligible_deterministic"
  | "promoted_soft";

/**
 * The per-story/event verdict read off the enrichment-state row — the
 * AUTHORITATIVE source for the floor result + coverage, present even when
 * there are zero evidence rows (a `complete`-coverage no-match story/event).
 * `null` on an {@link IocEnrichment} means *not run* (no completed state
 * row), which is distinct from a present verdict with no evidence.
 */
export interface IocEnrichmentVerdict {
  knownIocHit: boolean;
  coverageStatus: CoverageStatus;
}

/**
 * One resolved supporting-evidence row for display. The `indicator` is the
 * redaction-consistent value already resolved for the viewer (an external
 * indicator shown raw, a customer-asset token de-mapped within its own
 * `(sourceAiceId, memberEventKey)` scope, or — when the de-map is
 * unavailable — the bare token with {@link indicatorRedacted} set). The
 * source/provenance fields carry the feed-source citation.
 */
export interface IocEvidenceItem {
  /**
   * Display form of the indicator: a de-mapped customer-asset value, a raw
   * external indicator, or — when de-map is unavailable — the bare
   * `<<REDACTED_*_NNN>>` token (token-only safe degrade).
   */
  indicator: string;
  /**
   * True when {@link indicator} is still a redaction token (the de-map could
   * not run for the viewer) — the UI labels it as a redacted indicator rather
   * than leaking a wrong value.
   */
  indicatorRedacted: boolean;
  /** Redaction-map scope (event aice id) the indicator is interpretable in. */
  sourceAiceId: string;
  /** Redaction-map scope (member event key) the indicator is scoped to. */
  memberEventKey: string;
  /** Human-readable source label, or the `source_policy_id` itself as fallback. */
  sourceLabel: string;
  sourcePolicyId: string;
  hitType: "deterministic_ioc" | "soft_reputation";
  floorEligible: boolean;
  /** Derived class for the visual distinction (RFC 0003 #589). */
  evidenceClass: IocEvidenceClass;
  /** Per-row coverage status at the time the match was found (nullable). */
  coverageStatus: CoverageStatus | null;
  /** Feed snapshot provenance — version / content hash (either may be null). */
  sourceVersion: string | null;
  feedHash: string | null;
  checkedAt: Date;
}

/**
 * The full IOC-enrichment surface for a story or event: the state-row
 * verdict (`null` = not run) plus the supporting evidence rows. Returned by
 * the loader and rendered by {@link IocEvidenceSection}.
 */
export interface IocEnrichment {
  /** `null` = enrichment not run (no completed state row → render "not run"). */
  verdict: IocEnrichmentVerdict | null;
  evidence: IocEvidenceItem[];
}

/** The not-run sentinel: no completed state row and no evidence. */
export const NOT_RUN_IOC_ENRICHMENT: IocEnrichment = {
  verdict: null,
  evidence: [],
};

/**
 * Derive an evidence row's class from `(hit_type, floor_eligible)`. Only a
 * floor-eligible deterministic IOC drove the floor; a floor-ineligible
 * deterministic IOC and any soft-reputation match are evidence-only context.
 */
export function classifyEvidence(row: {
  hitType: string;
  floorEligible: boolean;
}): IocEvidenceClass {
  if (row.hitType === "deterministic_ioc") {
    return row.floorEligible
      ? "floor_supporting"
      : "floor_ineligible_deterministic";
  }
  return "promoted_soft";
}

// An evidence-row indicator is an EVENT-scope `<<REDACTED_IP_NNN>>` token
// (numbering restarts per event), NOT a story-narrative `E{i}`/`F{k}` token.
// Anchored so a raw external indicator (e.g. `1.2.3.4`) is never mistaken for
// a token. Mirrors the alphabet in `restore.ts`.
const REDACTION_TOKEN_RE = /^<<REDACTED_(?:IP|EMAIL|MAC|DOMAIN)_\d+>>$/;

/** Whether `s` is exactly one event-scope redaction token. */
export function isRedactionToken(s: string): boolean {
  return REDACTION_TOKEN_RE.test(s);
}

/**
 * The verdict's render state (acceptance criteria 4/5), distinguishing the
 * three legible cases plus the positive hit:
 *   - `not_run`          — no completed state row → "IOC enrichment not run /
 *                          unavailable" (NEVER a clean verdict).
 *   - `hit`              — `known_ioc_hit = true` → a known IOC drove the floor.
 *   - `clean_complete`   — `false` + `complete` → "no known IOC, fully checked".
 *   - `clean_incomplete` — `false` + `unknown`/`stale`/`partial` → "couldn't
 *                          fully check" (false-unknown, ties to #498).
 */
export type IocVerdictState =
  | { kind: "not_run" }
  | { kind: "hit"; coverageStatus: CoverageStatus }
  | { kind: "clean_complete" }
  | { kind: "clean_incomplete"; coverageStatus: CoverageStatus };

export function iocVerdictState(
  verdict: IocEnrichmentVerdict | null,
): IocVerdictState {
  if (verdict === null) return { kind: "not_run" };
  if (verdict.knownIocHit) {
    return { kind: "hit", coverageStatus: verdict.coverageStatus };
  }
  if (verdict.coverageStatus === "complete") return { kind: "clean_complete" };
  return { kind: "clean_incomplete", coverageStatus: verdict.coverageStatus };
}

// Display order: floor-supporting first (prominent — it drove the verdict),
// then floor-ineligible deterministic, then promoted soft (supporting
// context). Within a class, newest `checked_at` first.
const CLASS_ORDER: Record<IocEvidenceClass, number> = {
  floor_supporting: 0,
  floor_ineligible_deterministic: 1,
  promoted_soft: 2,
};

/** Stable comparator: by class prominence, then newest `checkedAt`. */
export function compareEvidence(
  a: IocEvidenceItem,
  b: IocEvidenceItem,
): number {
  const byClass = CLASS_ORDER[a.evidenceClass] - CLASS_ORDER[b.evidenceClass];
  if (byClass !== 0) return byClass;
  return b.checkedAt.getTime() - a.checkedAt.getTime();
}
