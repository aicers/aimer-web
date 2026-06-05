import type { useTranslations } from "next-intl";
import type { ListFilterBarLabels } from "@/components/analysis/list-filter-bar";

type AnalysisTranslations = ReturnType<typeof useTranslations<"analysis">>;

// Resolve the translated labels the (synchronous) {@link ListFilterBar}
// needs from the `analysis.filters` namespace. Both customer-scoped list
// pages call this so the time-window labels and control captions stay in one
// place — the lib filter module (`list-filters.ts`) carries only stable ids.
export function filterBarLabels(t: AnalysisTranslations): ListFilterBarLabels {
  return {
    priority: t("filters.priority"),
    all: t("filters.all"),
    timeWindow: t("filters.timeWindow"),
    apply: t("filters.apply"),
    windows: {
      all: t("filters.windowAll"),
      "24h": t("filters.window24h"),
      "7d": t("filters.window7d"),
      "30d": t("filters.window30d"),
    },
  };
}
