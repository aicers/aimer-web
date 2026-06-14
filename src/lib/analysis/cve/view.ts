// RFC 0005 — CVE render view types + the no-CVE state machine (Scope 4).
//
// Pure (no `server-only`, no I/O) so both the server-component loaders and
// the chip components import the same parsing + state logic, and the three
// zero-CVE states are unit-testable directly.

import type { PriorityTier } from "../priority-tier";
import { CVE_SOURCE_LABELS, type CveRecord, type CveStatus } from "./catalog";

/** The stored, enriched CVE record a chip renders. */
export type CveRefView = CveRecord;

/**
 * Defensively parse the `cve_refs` JSONB column into render views. pg
 * already returns JSONB as parsed JS, so this validates the array shape
 * and drops anything without a canonical `cve` string (legacy / corrupt
 * rows), mirroring how the TTP loader tolerates absent vendor entries.
 */
export function parseCveRefs(raw: unknown): CveRefView[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (x): x is CveRefView =>
      typeof x === "object" &&
      x !== null &&
      typeof (x as { cve?: unknown }).cve === "string",
  );
}

/**
 * Format the compact, source-cited payload line for a CVE chip, e.g.
 * `CVSS 9.8 [NVD] · KEV [CISA] · EPSS 0.94 / p99 [FIRST]`. Only facts from
 * available sources are present (the rest are null), so the line shows
 * exactly what was validated, with each datum carrying its citing source.
 * The EPSS datum carries BOTH the probability score and its percentile
 * rank (`p99`), as RFC 0005 requires the stored score + percentile to reach
 * the user — the percentile is the at-a-glance "how exploited relative to
 * everything else" signal the bare probability does not convey.
 */
export function formatCvePayload(r: CveRefView): string {
  const parts: string[] = [];
  if (r.cvss) {
    parts.push(`CVSS ${r.cvss.score} [${CVE_SOURCE_LABELS[r.cvss.source]}]`);
  }
  if (r.kev?.knownExploited) {
    parts.push(`KEV [${CVE_SOURCE_LABELS[r.kev.source]}]`);
  }
  if (r.epss) {
    // EPSS percentile is a 0–1 fraction; render it as an integer rank
    // (`p99`) alongside the raw probability score.
    const pct = Math.round(r.epss.percentile * 100);
    parts.push(
      `EPSS ${r.epss.score} / p${pct} [${CVE_SOURCE_LABELS[r.epss.source]}]`,
    );
  }
  // Surface an in-the-wild signal that the KEV known-exploited marker did
  // not already convey (e.g. a threat-intel "exploited" flag without a KEV
  // listing), so this validated datum is never silently dropped.
  if (r.inTheWild && !r.kev?.knownExploited) {
    parts.push(`In the wild [${CVE_SOURCE_LABELS.kev}]`);
  }
  return parts.join(" · ");
}

/**
 * The validating sources a chip cites, as human-facing labels in citation
 * order (e.g. `NVD · CISA · FIRST`). Rendered as a footer so EVERY chip
 * shows its provenance — including a record whose only datum is an NVD
 * summary or an in-the-wild signal, whose payload line would otherwise be
 * empty.
 */
export function formatCveSources(r: CveRefView): string {
  return r.sources.map((s) => CVE_SOURCE_LABELS[s]).join(" · ");
}

/**
 * Whether a threat is "significant" enough that an authoritative no-CVE
 * result warrants the heightened-caution / possible-novelty narrative.
 * Derived from the existing priority tier (CRITICAL / HIGH) — NOT a new
 * severity mechanism (narrative-only v1). Tunable here.
 */
const SIGNIFICANT_TIERS = new Set<PriorityTier>(["CRITICAL", "HIGH"]);

export function isCveSignificant(tier: PriorityTier): boolean {
  return SIGNIFICANT_TIERS.has(tier);
}

/**
 * The CVE row's render state, gated on `cve_status` (Scope 4 / the three
 * distinct "no CVE" states):
 *   - `absent`          — `cve_status` is NULL: the CVE path did not run
 *                         (feature inactive) → render nothing at all.
 *   - `chips`           — one or more validated CVEs → render the chips.
 *   - `novelty`         — `complete` + zero + significant → the confirmed
 *                         "no known CVE → heightened caution / possible
 *                         novelty" narrative (narrative-only v1).
 *   - `irrelevant`      — `complete` + zero + not significant → omit the
 *                         row (a CVE-irrelevant analysis).
 *   - `could_not_verify`— degraded (`unknown`/`stale`/`partial`) + zero →
 *                         "CVE enrichment unavailable — could not verify";
 *                         NEVER the confident caution narrative.
 */
export type CveRowState =
  | { kind: "absent" }
  | { kind: "chips"; refs: CveRefView[] }
  | { kind: "novelty" }
  | { kind: "irrelevant" }
  | { kind: "could_not_verify" };

export function cveRowState(args: {
  refs: CveRefView[];
  status: CveStatus | null;
  significant: boolean;
}): CveRowState {
  if (args.status === null) return { kind: "absent" };
  if (args.refs.length > 0) return { kind: "chips", refs: args.refs };
  if (args.status === "complete") {
    return args.significant ? { kind: "novelty" } : { kind: "irrelevant" };
  }
  // `partial` / `unknown` / `stale`: the check was degraded, so absence was
  // not established — never emit the confident caution narrative.
  return { kind: "could_not_verify" };
}

/**
 * Whether a CVE row state has any user-facing surface. The `absent`
 * (feature-not-active) and `irrelevant` (confirmed CVE-irrelevant) states
 * render nothing — so a compare column in either state must NOT leak a CVE
 * row, and the shared compare heading is omitted only when BOTH columns are
 * surfaceless.
 */
export function cveRowHasSurface(state: CveRowState): boolean {
  return (
    state.kind === "chips" ||
    state.kind === "novelty" ||
    state.kind === "could_not_verify"
  );
}
