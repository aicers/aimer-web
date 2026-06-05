// "Cited by" trail for leaf (event / story) detail pages (T2, #396).
//
// Renders the report(s) that cite this leaf as a newest-first list, each
// linking back up to the citing report pinned to the exact variant +
// generation that consumed the leaf (parent #386 generation-pin
// contract). A leaf cited by no report renders nothing — an empty trail
// is a normal state, not an error — so the page can mount this
// unconditionally.

import Link from "next/link";
import type { useTranslations } from "next-intl";
import { Timestamp } from "@/components/timestamp";
import type { CitedByReport } from "@/lib/analysis/cited-by-loader";
import type { PriorityTier } from "@/lib/analysis/priority-tier";
import { LIVE_BUCKET_DATE } from "@/lib/analysis/report-bucket-date";

// The `analysis`-namespace translator, resolved by the (server-component)
// caller and passed in so this presentational component stays synchronous.
type AnalysisTranslations = ReturnType<typeof useTranslations<"analysis">>;

const TIER_CLASSES: Record<PriorityTier, string> = {
  CRITICAL: "border-rose-500 bg-rose-100 text-rose-900",
  HIGH: "border-orange-400 bg-orange-100 text-orange-900",
  MEDIUM: "border-amber-300 bg-amber-50 text-amber-900",
  LOW: "border-slate-300 bg-slate-50 text-slate-700",
};

// Build the citing-report link, pinning the exact variant + generation
// the report consumed so the trail lands on what that report actually
// cited (not the latest report variant). `lang` is the citing row's
// report language as an app-locale code, which the report page validates
// and maps back to the enum.
function reportHref(
  locale: string,
  customerId: string,
  report: CitedByReport,
): string {
  const query = new URLSearchParams({
    tz: report.tz,
    lang: report.locale,
    model_name: report.modelName,
    model: report.model,
    generation: String(report.generation),
  }).toString();
  return `/${locale}/customers/${customerId}/analysis/reports/${report.period}/${report.bucketDate}?${query}`;
}

export function CitedByTrail({
  locale,
  customerId,
  reports,
  t,
  periodLabels,
}: {
  locale: string;
  customerId: string;
  reports: CitedByReport[];
  t: AnalysisTranslations;
  /** Translated period labels (`reportPeriod`), keyed by period. */
  periodLabels: Record<string, string>;
}) {
  if (reports.length === 0) return null;

  return (
    <section className="mt-8" data-testid="cited-by-trail">
      <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
        {t("citedBy.heading")}
      </h2>
      <p className="mb-3 text-xs text-muted-foreground">
        {t("citedBy.description")}
      </p>
      <ul className="space-y-2">
        {reports.map((r) => {
          const isLive =
            r.period === "LIVE" || r.bucketDate === LIVE_BUCKET_DATE;
          const period = (periodLabels[r.period] ?? r.period).toUpperCase();
          return (
            <li
              key={`${r.period}-${r.bucketDate}-${r.tz}-${r.generation}`}
              data-testid={`cited-by-report-${r.period}-${r.bucketDate}`}
            >
              <Link
                href={reportHref(locale, customerId, r)}
                className="block rounded border border-border bg-card px-4 py-3 transition-colors hover:border-foreground"
              >
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium text-foreground">
                      {isLive
                        ? t("citedBy.liveReport", { period })
                        : t("citedBy.periodReport", {
                            period,
                            bucketDate: r.bucketDate,
                          })}
                    </div>
                    <div className="mt-0.5 text-xs text-muted-foreground">
                      {r.tz} •{" "}
                      {t("common.generation", { generation: r.generation })} •{" "}
                      <Timestamp at={r.requestedAt} />
                    </div>
                  </div>
                  <PriorityBadge tier={r.priorityTier} />
                </div>
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

// Scoped testid so it doesn't collide with the page's own tier badge.
function PriorityBadge({ tier }: { tier: PriorityTier }) {
  return (
    <span
      data-testid="cited-by-priority-badge"
      data-tier={tier}
      className={`inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-xs font-semibold ${TIER_CLASSES[tier]}`}
    >
      {tier}
    </span>
  );
}
