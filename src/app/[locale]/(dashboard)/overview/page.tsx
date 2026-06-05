import Link from "next/link";
import { forbidden, redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";

import {
  CountBadge,
  EventRow,
  PartialFailureNotice,
  ReportRow,
  StoryRow,
  SurfaceEmptyState,
} from "@/components/overview/overview-rows";
import {
  type FailedCustomer,
  loadCrossCustomerOverview,
} from "@/lib/analysis/cross-customer-overview";
import { loadScopePage } from "@/lib/navigation/scope-page-loader";

interface PageProps {
  params: Promise<{ locale: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}

// Per-type cap on the combined landing. The dedicated pages show the full
// top-K (25); the landing mixes all three types, so it shows a shorter
// highest-risk preview of each and links through for more.
const LANDING_PER_TYPE = 5;

// Cross-customer combined overview landing (WS2, #391). The only page that
// mixes types: it shows the top highest-risk reports, threat stories, and
// suspicious events plus a per-type count, and links each section to its
// dedicated page. Scope and permission filtering are identical to the
// dedicated pages (each type is gated by its own permission).
export default async function OverviewPage({
  params,
  searchParams,
}: PageProps) {
  const { locale } = await params;
  const sp = (await searchParams) ?? {};

  const scope = await loadScopePage({
    pathname: `/${locale}/overview`,
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
  const nowLabel = tA("common.now");
  const scoreLabel = (severity: number, likelihood: number): string =>
    tA("overview.scorePair", {
      severity: severity.toFixed(2),
      likelihood: likelihood.toFixed(2),
    });
  const data = await loadCrossCustomerOverview({
    scopeCustomerIds: scope.scope.customerIds,
    surfaces: ["reports", "stories", "events"],
    cap: LANDING_PER_TYPE,
  });
  if (data.kind === "unauthorized") redirect("/api/auth/sign-in");
  if (data.kind === "bridge") forbidden();

  const reports = data.reports ?? empty();
  const stories = data.stories ?? empty();
  const events = data.events ?? empty();

  // Carry the active scope on the "view all" links so the section pages open
  // under the same scope the landing was viewed in.
  const scopeQuery =
    scope.scope.canonical === "all"
      ? ""
      : `?scope=${encodeURIComponent(scope.scope.canonical)}`;

  return (
    <div className="mx-auto max-w-4xl px-4 py-8 sm:px-6">
      <header className="mb-6">
        <h1 className="text-2xl font-bold text-foreground">{t("overview")}</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {tA("overview.subtitle")}
        </p>
      </header>

      <PartialFailureNotice
        failed={mergeFailures(
          reports.failedCustomers,
          stories.failedCustomers,
          events.failedCustomers,
        )}
        introLabel={tA("overview.partialFailureIntro")}
        retryLabel={tA("overview.partialFailureRetry")}
      />

      <div className="space-y-8">
        <Section
          title={t("reports")}
          count={reports.totalCount}
          href={`/${locale}/reports${scopeQuery}`}
          emptyTestid="overview-reports-empty"
          emptyLabel={tA("overview.reportsEmpty")}
          viewAllLabel={tA("overview.viewAll")}
        >
          {reports.items.map((row) => (
            <li
              key={`${row.customerId}-${row.period}-${row.bucketDate}-${row.tz}`}
            >
              <ReportRow
                row={row}
                locale={locale}
                periodLabels={periodLabels}
                nowLabel={nowLabel}
              />
            </li>
          ))}
        </Section>

        <Section
          title={t("threatStories")}
          count={stories.totalCount}
          href={`/${locale}/threat-stories${scopeQuery}`}
          emptyTestid="overview-stories-empty"
          emptyLabel={tA("overview.storiesEmpty")}
          viewAllLabel={tA("overview.viewAll")}
        >
          {stories.items.map((row) => (
            <li key={`${row.customerId}-${row.storyId}`}>
              <StoryRow
                row={row}
                locale={locale}
                label={tA("overview.storyLabel", { storyId: row.storyId })}
                scoreLabel={scoreLabel(row.severityScore, row.likelihoodScore)}
              />
            </li>
          ))}
        </Section>

        <Section
          title={t("suspiciousEvents")}
          count={events.totalCount}
          href={`/${locale}/suspicious-events${scopeQuery}`}
          emptyTestid="overview-events-empty"
          emptyLabel={tA("overview.eventsEmpty")}
          viewAllLabel={tA("overview.viewAll")}
        >
          {events.items.map((row) => (
            <li key={`${row.customerId}-${row.aiceId}-${row.eventKey}`}>
              <EventRow
                row={row}
                locale={locale}
                label={tA("overview.eventLabel", { eventKey: row.eventKey })}
                scoreLabel={scoreLabel(row.severityScore, row.likelihoodScore)}
              />
            </li>
          ))}
        </Section>
      </div>
    </div>
  );
}

function empty() {
  return { items: [], totalCount: 0, failedCustomers: [] as FailedCustomer[] };
}

// Dedup failed customers across the three surfaces by id so the same
// unreachable DB is listed once.
function mergeFailures(...lists: FailedCustomer[][]): FailedCustomer[] {
  const byId = new Map<string, FailedCustomer>();
  for (const list of lists) {
    for (const f of list) byId.set(f.id, f);
  }
  return [...byId.values()];
}

function Section({
  title,
  count,
  href,
  children,
  emptyLabel,
  emptyTestid,
  viewAllLabel,
}: {
  title: string;
  count: number;
  href: string;
  children: React.ReactNode[];
  emptyLabel: string;
  emptyTestid: string;
  viewAllLabel: string;
}) {
  return (
    <section aria-label={title} data-testid={`overview-section-${emptyTestid}`}>
      <div className="mb-2 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            {title}
          </h2>
          <CountBadge count={count} />
        </div>
        <Link
          href={href}
          className="text-xs font-medium text-foreground underline-offset-2 hover:underline"
        >
          {viewAllLabel}
        </Link>
      </div>
      {children.length === 0 ? (
        <SurfaceEmptyState testid={emptyTestid} label={emptyLabel} />
      ) : (
        <ul className="space-y-2">{children}</ul>
      )}
    </section>
  );
}
