// RFC 0005 — recent-CVE landscape selection + priming supply (Scope 5).
//
// aimer-web computes a scoped recent-CVE landscape (recent CISA-KEV +
// high-EPSS) and supplies it to the analysis LLM so it can name
// post-cutoff CVEs. The landscape is framed as CANDIDATE context to
// verify — possibly inapplicable — and the model is told it may attribute
// no CVE; the post-analysis validation pass (`validateCveRefs`) drops
// anything that doesn't hold up. Forcing / maximizing CVE attach-rate is
// an explicit anti-goal: the framing here is the main over-attribution
// mitigation.
//
//   - Story rides the existing `enrichmentFacts` channel (verify-me
//     one-liners) — see `buildStoryLandscapeFacts`.
//   - Event uses the shipped `cveLandscape: [CveLandscapeEntryInput!]!`
//     arg, built as `[{ cve, description }]`, with a COST-MANAGED KEV-only
//     slice because event analysis is high-volume (#493 caps) — see
//     `buildEventLandscapeEntries`.

import type { CveLandscapeRecord, CveSourceId } from "./catalog";

// --- Tunable selection constants (RFC 0005 Scope 5) ----------------------

/** Recency window for the story landscape — recent CISA-KEV + high-EPSS. */
export const STORY_LANDSCAPE_WINDOW_DAYS = 90;
/** Overall story landscape cap (RFC 0005: ~30–50). */
export const STORY_LANDSCAPE_CAP = 40;
/** EPSS at/above which a recent CVE qualifies for the high-EPSS slice. */
export const HIGH_EPSS_THRESHOLD = 0.5;
/**
 * Event landscape cap — a deliberately SMALLER KEV-only slice (~15–20)
 * for the high-volume event path (cost management is aimer-web's job; the
 * backend applies no gating).
 */
export const EVENT_LANDSCAPE_CAP = 18;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

// --- Framing (anti over-attribution) -------------------------------------

/**
 * Leading framing fact prepended to the story `enrichmentFacts` landscape.
 * States plainly that the list is candidate, often-inapplicable context
 * and that attributing NO CVE is a valid outcome — never force a match.
 */
export const STORY_LANDSCAPE_FRAMING =
  "Recent-CVE landscape (candidate context only): the CVEs below are recently " +
  "published / known-exploited entries provided as possibly-inapplicable leads " +
  "to verify against the evidence. Most will NOT apply. Attribute a CVE only " +
  "when the evidence supports it; naming no CVE is a valid, expected outcome — " +
  "never force a match.";

/** Inline candidate marker folded into each event landscape description. */
const EVENT_CANDIDATE_PREFIX = "candidate (verify; may not apply)";

/** Selection / build options. `now` drives the recency window. */
export interface LandscapeSelectOptions {
  /** Current instant (ISO) — recency is measured against this. */
  now: string;
  windowDays?: number;
  cap?: number;
  highEpssThreshold?: number;
}

function dateMs(iso: string | undefined): number {
  if (iso === undefined) return Number.NaN;
  return Date.parse(iso);
}

/** Most recent of KEV-added / published, for recency ordering. */
function recencyMs(r: CveLandscapeRecord): number {
  const added = dateMs(r.kevDateAdded);
  const published = dateMs(r.publishedAt);
  const candidates = [added, published].filter((n) => !Number.isNaN(n));
  return candidates.length > 0
    ? Math.max(...candidates)
    : Number.NEGATIVE_INFINITY;
}

/**
 * Deterministic ordering: KEV first, then higher EPSS, then more recent,
 * then canonical id — so a pinned fixture yields a stable selection.
 */
function compareForLandscape(
  a: CveLandscapeRecord,
  b: CveLandscapeRecord,
): number {
  if (a.kev !== b.kev) return a.kev ? -1 : 1;
  const ea = a.epss ?? -1;
  const eb = b.epss ?? -1;
  if (ea !== eb) return eb - ea;
  const ra = recencyMs(a);
  const rb = recencyMs(b);
  if (ra !== rb) return rb - ra;
  return a.cve.localeCompare(b.cve);
}

/**
 * Apply the F2 source selection to landscape candidates BEFORE selection,
 * so a gated-off source never primes the LLM. A KEV signal is cleared when
 * the `kev` source is disabled and the EPSS signal when `epss` is disabled;
 * a record left with neither candidacy signal is removed entirely. (NVD
 * carries no landscape-candidacy signal of its own, so it does not gate
 * entries here.) Because `buildLandscapeDescription` rebuilds the
 * KEV/EPSS context from these fields, clearing them also keeps the
 * disabled-source context out of the prompt text.
 */
export function restrictLandscapeToEnabledSources(
  records: readonly CveLandscapeRecord[],
  enabled: ReadonlySet<CveSourceId>,
): CveLandscapeRecord[] {
  const kevEnabled = enabled.has("kev");
  const epssEnabled = enabled.has("epss");
  const out: CveLandscapeRecord[] = [];
  for (const r of records) {
    const kev = kevEnabled ? r.kev : false;
    const epss = epssEnabled ? r.epss : null;
    if (!kev && epss === null) continue;
    out.push({
      ...r,
      kev,
      kevDateAdded: kev ? r.kevDateAdded : undefined,
      epss,
      epssPercentile: epss === null ? null : r.epssPercentile,
    });
  }
  return out;
}

/**
 * Story landscape: recent CISA-KEV ∪ recent high-EPSS within the window,
 * deduped, ordered, capped (~30–50). The breadth (KEV + high-EPSS) suits
 * the lower-volume story path.
 */
export function selectStoryLandscape(
  records: readonly CveLandscapeRecord[],
  options: LandscapeSelectOptions,
): CveLandscapeRecord[] {
  const nowMs = Date.parse(options.now);
  const windowDays = options.windowDays ?? STORY_LANDSCAPE_WINDOW_DAYS;
  const cap = options.cap ?? STORY_LANDSCAPE_CAP;
  const threshold = options.highEpssThreshold ?? HIGH_EPSS_THRESHOLD;
  const cutoffMs = nowMs - windowDays * MS_PER_DAY;

  const selected = records.filter((r) => {
    const recent = recencyMs(r) >= cutoffMs;
    if (!recent) return false;
    const isRecentKev = r.kev;
    const isHighEpss = (r.epss ?? 0) >= threshold;
    return isRecentKev || isHighEpss;
  });
  selected.sort(compareForLandscape);
  return selected.slice(0, cap);
}

/**
 * Event landscape: a SMALLER KEV-only slice (~15–20) for the high-volume
 * event path. KEV (known-exploited) is the highest-signal subset, keeping
 * the per-event prompt cost bounded.
 */
export function selectEventLandscape(
  records: readonly CveLandscapeRecord[],
  options: LandscapeSelectOptions,
): CveLandscapeRecord[] {
  const nowMs = Date.parse(options.now);
  const windowDays = options.windowDays ?? STORY_LANDSCAPE_WINDOW_DAYS;
  const cap = options.cap ?? EVENT_LANDSCAPE_CAP;
  const cutoffMs = nowMs - windowDays * MS_PER_DAY;

  const selected = records.filter((r) => r.kev && recencyMs(r) >= cutoffMs);
  selected.sort(compareForLandscape);
  return selected.slice(0, cap);
}

/**
 * Fold recency / KEV / EPSS context into a one-line description string —
 * the only context channel the backend `cveLandscape` arg exposes (it
 * takes just `cve` + `description`). Always prefixed with the candidate
 * marker so each entry reads as a lead to verify, not ground truth.
 */
export function buildLandscapeDescription(r: CveLandscapeRecord): string {
  const parts: string[] = [EVENT_CANDIDATE_PREFIX];
  if (r.kev) {
    parts.push(r.kevDateAdded ? `CISA KEV ${r.kevDateAdded}` : "CISA KEV");
  }
  if (r.epss !== null) {
    const pct =
      r.epssPercentile !== null
        ? ` (p${Math.round(r.epssPercentile * 100)})`
        : "";
    parts.push(`EPSS ${r.epss.toFixed(2)}${pct}`);
  }
  parts.push(r.description);
  return parts.join(" · ");
}

/**
 * Build the story `enrichmentFacts` landscape: the framing fact first,
 * then one verify-me line per entry. Returned as plain strings ready to
 * wrap in `{ text }` at the GraphQL boundary.
 */
export function buildStoryLandscapeFacts(
  records: readonly CveLandscapeRecord[],
): string[] {
  if (records.length === 0) return [];
  return [
    STORY_LANDSCAPE_FRAMING,
    ...records.map((r) => `${r.cve}: ${buildLandscapeDescription(r)}`),
  ];
}

/** Build the event `cveLandscape` arg payload: `[{ cve, description }]`. */
export function buildEventLandscapeEntries(
  records: readonly CveLandscapeRecord[],
): Array<{ cve: string; description: string }> {
  return records.map((r) => ({
    cve: r.cve,
    description: buildLandscapeDescription(r),
  }));
}
