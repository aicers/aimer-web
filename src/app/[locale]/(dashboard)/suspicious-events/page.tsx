import { forbidden, redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";

import {
  CountBadge,
  EventRow,
  PartialFailureNotice,
  SurfaceEmptyState,
} from "@/components/overview/overview-rows";
import { loadCrossCustomerOverview } from "@/lib/analysis/cross-customer-overview";
import { loadScopePage } from "@/lib/navigation/scope-page-loader";

interface PageProps {
  params: Promise<{ locale: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}

// Cross-customer Suspicious Events overview (WS2, #391). Under the active
// scope (WS1), surfaces the highest-risk / most-recent analyzed events across
// every customer the user can both access AND read (`analyses:read`). Bounded
// top-K; the long tail lives on the single-customer list page (WS3).
export default async function SuspiciousEventsPage({
  params,
  searchParams,
}: PageProps) {
  const { locale } = await params;
  const sp = (await searchParams) ?? {};

  const scope = await loadScopePage({
    pathname: `/${locale}/suspicious-events`,
    searchParams: sp,
  });
  if (scope.kind === "unauthorized") redirect("/api/auth/sign-in");
  if (scope.kind === "redirect") redirect(scope.target);
  if (scope.kind === "bridge") forbidden();

  const t = await getTranslations("nav");
  const tA = await getTranslations("analysis");
  const data = await loadCrossCustomerOverview({
    scopeCustomerIds: scope.scope.customerIds,
    surfaces: ["events"],
  });
  if (data.kind === "unauthorized") redirect("/api/auth/sign-in");
  if (data.kind === "bridge") forbidden();

  const events = data.events ?? {
    items: [],
    totalCount: 0,
    failedCustomers: [],
  };

  return (
    <div className="mx-auto max-w-4xl px-4 py-8 sm:px-6">
      <header className="mb-6 flex items-center gap-3">
        <h1 className="text-2xl font-bold text-foreground">
          {t("suspiciousEvents")}
        </h1>
        <CountBadge count={events.totalCount} />
      </header>

      <PartialFailureNotice
        failed={events.failedCustomers}
        introLabel={tA("overview.partialFailureIntro")}
        retryLabel={tA("overview.partialFailureRetry")}
      />

      {events.items.length === 0 ? (
        <SurfaceEmptyState
          testid="suspicious-events-empty"
          label={tA("overview.eventsEmptyFull")}
        />
      ) : (
        <ul className="space-y-2" data-testid="suspicious-events-list">
          {events.items.map((row) => (
            <li key={`${row.customerId}-${row.aiceId}-${row.eventKey}`}>
              <EventRow
                row={row}
                locale={locale}
                label={tA("overview.eventLabel", { eventKey: row.eventKey })}
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
