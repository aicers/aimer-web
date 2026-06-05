import { forbidden, redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";

import {
  CountBadge,
  PartialFailureNotice,
  ReportRow,
  SurfaceEmptyState,
} from "@/components/overview/overview-rows";
import { loadCrossCustomerOverview } from "@/lib/analysis/cross-customer-overview";
import { loadScopePage } from "@/lib/navigation/scope-page-loader";

interface PageProps {
  params: Promise<{ locale: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}

// Cross-customer Reports overview (WS2, #391). Surfaces the highest-risk /
// most-recent periodic reports across every customer the user can both access
// AND read (`reports:read`). Report rows expose the priority tier ONLY — the
// aggregate score that drives ordering is never displayed (#386 guardrail).
export default async function ReportsPage({ params, searchParams }: PageProps) {
  const { locale } = await params;
  const sp = (await searchParams) ?? {};

  const scope = await loadScopePage({
    pathname: `/${locale}/reports`,
    searchParams: sp,
  });
  if (scope.kind === "unauthorized") redirect("/api/auth/sign-in");
  if (scope.kind === "redirect") redirect(scope.target);
  if (scope.kind === "bridge") forbidden();

  const t = await getTranslations("nav");
  const tA = await getTranslations("analysis");
  const tPeriod = await getTranslations("reportPeriod");
  const periodLabels: Record<string, string> = {
    LIVE: tPeriod("LIVE"),
    DAILY: tPeriod("DAILY"),
    WEEKLY: tPeriod("WEEKLY"),
    MONTHLY: tPeriod("MONTHLY"),
  };
  const data = await loadCrossCustomerOverview({
    scopeCustomerIds: scope.scope.customerIds,
    surfaces: ["reports"],
  });
  if (data.kind === "unauthorized") redirect("/api/auth/sign-in");
  if (data.kind === "bridge") forbidden();

  const reports = data.reports ?? {
    items: [],
    totalCount: 0,
    failedCustomers: [],
  };

  return (
    <div className="mx-auto max-w-4xl px-4 py-8 sm:px-6">
      <header className="mb-6 flex items-center gap-3">
        <h1 className="text-2xl font-bold text-foreground">{t("reports")}</h1>
        <CountBadge count={reports.totalCount} />
      </header>

      <PartialFailureNotice
        failed={reports.failedCustomers}
        introLabel={tA("overview.partialFailureIntro")}
        retryLabel={tA("overview.partialFailureRetry")}
      />

      {reports.items.length === 0 ? (
        <SurfaceEmptyState
          testid="reports-empty"
          label={tA("overview.reportsEmptyFull")}
        />
      ) : (
        <ul className="space-y-2" data-testid="reports-list">
          {reports.items.map((row) => (
            <li
              key={`${row.customerId}-${row.period}-${row.bucketDate}-${row.tz}`}
            >
              <ReportRow
                row={row}
                locale={locale}
                periodLabels={periodLabels}
                nowLabel={tA("common.now")}
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
