import { forbidden, redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";

import {
  CountBadge,
  PartialFailureNotice,
  StoryRow,
  SurfaceEmptyState,
} from "@/components/overview/overview-rows";
import { loadCrossCustomerOverview } from "@/lib/analysis/cross-customer-overview";
import { loadScopePage } from "@/lib/navigation/scope-page-loader";

interface PageProps {
  params: Promise<{ locale: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}

// Cross-customer Threat Stories overview (WS2, #391). Surfaces the highest-
// risk / most-recent threat stories across every customer the user can both
// access AND read (`analyses:read`). Honors the `story_analysis_state`
// lifecycle: `archived` and `pending` rows are excluded (the aggregator only
// considers `ready`/`dirty`), so no archived story leaks into the list.
export default async function ThreatStoriesPage({
  params,
  searchParams,
}: PageProps) {
  const { locale } = await params;
  const sp = (await searchParams) ?? {};

  const scope = await loadScopePage({
    pathname: `/${locale}/threat-stories`,
    searchParams: sp,
  });
  if (scope.kind === "unauthorized") redirect("/api/auth/sign-in");
  if (scope.kind === "redirect") redirect(scope.target);
  if (scope.kind === "bridge") forbidden();

  const t = await getTranslations("nav");
  const tA = await getTranslations("analysis");
  const data = await loadCrossCustomerOverview({
    scopeCustomerIds: scope.scope.customerIds,
    surfaces: ["stories"],
  });
  if (data.kind === "unauthorized") redirect("/api/auth/sign-in");
  if (data.kind === "bridge") forbidden();

  const stories = data.stories ?? {
    items: [],
    totalCount: 0,
    failedCustomers: [],
  };

  return (
    <div className="mx-auto max-w-4xl px-4 py-8 sm:px-6">
      <header className="mb-6 flex items-center gap-3">
        <h1 className="text-2xl font-bold text-foreground">
          {t("threatStories")}
        </h1>
        <CountBadge count={stories.totalCount} />
      </header>

      <PartialFailureNotice
        failed={stories.failedCustomers}
        locale={locale}
        t={tA}
      />

      {stories.items.length === 0 ? (
        <SurfaceEmptyState
          testid="threat-stories-empty"
          label={tA("overview.storiesEmptyFull")}
        />
      ) : (
        <ul className="space-y-2" data-testid="threat-stories-list">
          {stories.items.map((row) => (
            <li key={`${row.customerId}-${row.storyId}`}>
              <StoryRow
                row={row}
                locale={locale}
                label={tA("overview.storyLabel", { storyId: row.storyId })}
                scoreLabel={tA("overview.scorePair", {
                  severity: row.severityScore.toFixed(2),
                  likelihood: row.likelihoodScore.toFixed(2),
                })}
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
