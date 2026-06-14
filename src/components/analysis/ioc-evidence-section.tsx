// RFC 0003 / RFC 0005 — TI IOC evidence + feed-source citation section (#591).
//
// Renders the read-only IOC-enrichment surface on the story / event analysis
// pages: a verdict banner (the three legible states + a positive hit) driven
// by the enrichment-state row, plus the supporting feed-source citations.
//
//   Verdict (always shown — transparency, even with zero evidence):
//     - not_run          → "IOC enrichment not run / unavailable" (NEVER a
//                          clean verdict; visibly distinct from clean-complete);
//     - hit              → a known IOC drove `known_ioc_hit`;
//     - clean_complete   → "no known IOC, fully checked" (false-complete);
//     - clean_incomplete → "couldn't fully check" (false-unknown, ties to #498).
//
//   Citations: each surfaced match with its source label + provenance
//   (`source_version` / `feed_hash` / `checked_at`), visually distinguishing
//   floor-supporting hits (prominent — they drove the verdict) from
//   floor-ineligible deterministic / promoted-soft matches (supporting
//   context). The indicator is shown redaction-consistently by the loader: a
//   raw external value, a de-mapped customer asset, or — when de-map is
//   unavailable — the bare token, labelled as redacted.

import type { useTranslations } from "next-intl";
import { Timestamp } from "@/components/timestamp";
import {
  compareEvidence,
  type IocEnrichment,
  type IocEvidenceClass,
  type IocEvidenceItem,
  iocVerdictState,
} from "@/lib/analysis/ioc-evidence";

type AnalysisTranslations = ReturnType<typeof useTranslations<"analysis">>;

// Per-state banner styling. `not_run` is deliberately neutral (slate) so it
// reads as "unavailable", never as a confident clean result.
const VERDICT_CLASSES: Record<string, string> = {
  hit: "border-rose-400 bg-rose-50 text-rose-900",
  clean_complete: "border-emerald-300 bg-emerald-50 text-emerald-900",
  clean_incomplete: "border-amber-300 bg-amber-50 text-amber-900",
  not_run: "border-slate-300 bg-slate-50 text-slate-700",
};

// Per-class chip styling: floor-supporting is prominent (rose), the rest are
// muted supporting context.
const CLASS_CHIP_CLASSES: Record<IocEvidenceClass, string> = {
  floor_supporting: "border-rose-300 bg-rose-100 text-rose-900",
  floor_ineligible_deterministic:
    "border-slate-300 bg-slate-100 text-slate-700",
  promoted_soft: "border-slate-200 bg-slate-50 text-slate-600",
};

// Static keys (next-intl's `t` is typed on literal message keys, so a dynamic
// lookup table of key strings would not type-check).
function evidenceClassLabel(
  evidenceClass: IocEvidenceClass,
  t: AnalysisTranslations,
): string {
  switch (evidenceClass) {
    case "floor_supporting":
      return t("ioc.classFloorSupporting");
    case "floor_ineligible_deterministic":
      return t("ioc.classFloorIneligible");
    default:
      return t("ioc.classPromotedSoft");
  }
}

function VerdictBanner({
  enrichment,
  t,
}: {
  enrichment: IocEnrichment;
  t: AnalysisTranslations;
}) {
  const state = iocVerdictState(enrichment.verdict);
  let badge: string;
  let note: string;
  switch (state.kind) {
    case "hit":
      badge = t("ioc.hitBadge");
      note = t("ioc.hitNote", { status: state.coverageStatus });
      break;
    case "clean_complete":
      badge = t("ioc.cleanCompleteBadge");
      note = t("ioc.cleanCompleteNote");
      break;
    case "clean_incomplete":
      badge = t("ioc.cleanIncompleteBadge");
      note = t("ioc.cleanIncompleteNote", { status: state.coverageStatus });
      break;
    default:
      badge = t("ioc.notRunBadge");
      note = t("ioc.notRunNote");
      break;
  }
  return (
    <div
      role="status"
      data-testid="ioc-verdict"
      data-ioc-state={state.kind}
      className={`rounded border px-4 py-3 text-sm ${VERDICT_CLASSES[state.kind]}`}
    >
      <span className="font-semibold">{badge}</span> {note}
    </div>
  );
}

function EvidenceCitation({
  item,
  t,
}: {
  item: IocEvidenceItem;
  t: AnalysisTranslations;
}) {
  return (
    <li
      data-testid="ioc-evidence-row"
      data-evidence-class={item.evidenceClass}
      data-source-policy-id={item.sourcePolicyId}
      className="rounded border border-border bg-card px-3 py-2"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span
          data-testid="ioc-evidence-class"
          className={`inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${CLASS_CHIP_CLASSES[item.evidenceClass]}`}
        >
          {evidenceClassLabel(item.evidenceClass, t)}
        </span>
        {item.indicatorRedacted ? (
          <span
            data-testid="ioc-indicator"
            data-redacted="true"
            title={t("ioc.redactedIndicator")}
            className="font-mono text-sm text-muted-foreground"
          >
            {item.indicator}
          </span>
        ) : (
          <span
            data-testid="ioc-indicator"
            className="font-mono text-sm text-foreground"
          >
            {item.indicator}
          </span>
        )}
      </div>
      <div className="mt-1 text-xs text-muted-foreground">
        <span data-testid="ioc-source-label" className="font-medium">
          {t("ioc.sourceLabel")}: {item.sourceLabel}
        </span>
        {item.sourceVersion ? (
          <span>
            {" "}
            · {t("ioc.versionLabel")}: {item.sourceVersion}
          </span>
        ) : null}
        {item.feedHash ? (
          <span>
            {" "}
            · {t("ioc.feedHashLabel")}: {item.feedHash}
          </span>
        ) : null}
        <span>
          {" "}
          · {t("ioc.checkedAtLabel")}: <Timestamp at={item.checkedAt} />
        </span>
      </div>
    </li>
  );
}

/**
 * The full IOC evidence section. Always renders the verdict banner (the
 * three-state legibility surface) and, when present, the feed-source
 * citations. Pure presentation over the loader-resolved {@link IocEnrichment}
 * — it never re-derives privacy- or DB-shaped data.
 */
export function IocEvidenceSection({
  enrichment,
  t,
}: {
  enrichment: IocEnrichment;
  t: AnalysisTranslations;
}) {
  const evidence = [...enrichment.evidence].sort(compareEvidence);
  return (
    <section
      data-testid="ioc-evidence-section"
      className="mb-6 space-y-3"
      aria-label={t("ioc.heading")}
    >
      <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {t("ioc.heading")}
      </h2>
      <VerdictBanner enrichment={enrichment} t={t} />
      {evidence.length > 0 ? (
        <div data-testid="ioc-citations">
          <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {t("ioc.citationsHeading")}
          </h3>
          <ul className="space-y-2">
            {evidence.map((item) => (
              <EvidenceCitation
                key={`${item.sourcePolicyId}:${item.sourceAiceId}:${item.memberEventKey}:${item.indicator}`}
                item={item}
                t={t}
              />
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
