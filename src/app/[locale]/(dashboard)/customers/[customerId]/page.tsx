import Link from "next/link";
import { forbidden, notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { loadCustomerHubPage } from "@/lib/analysis/customer-hub-page-loader";

interface PageProps {
  params: Promise<{
    locale: string;
    customerId: string;
  }>;
}

// WS3 (#392) — customer hub. The entry point that links to a customer's
// reports, threat stories, and suspicious events, giving every leaf a
// navigable home. Sections render only when their permission is present;
// the hub 404s only for a non-member, and an in-scope bridge session is a
// real 403 via the `forbidden.tsx` boundary.
export default async function CustomerHubPage({ params }: PageProps) {
  const { locale, customerId } = await params;

  const outcome = await loadCustomerHubPage({ customerId });
  if (outcome.kind === "unauthorized") notFound();
  if (outcome.kind === "forbidden") forbidden();

  const { sections } = outcome;
  const anySection =
    sections.reports || sections.threatStories || sections.suspiciousEvents;
  const tA = await getTranslations("analysis");
  const tNav = await getTranslations("nav");

  return (
    <div className="mx-auto max-w-4xl px-4 py-8 sm:px-6">
      <header className="mb-6">
        <h1 className="text-2xl font-bold text-foreground">
          {tA("customerHub.title")}
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {tA("customerHub.subtitle")}
        </p>
      </header>

      {anySection ? (
        <div
          className="grid grid-cols-1 gap-4 sm:grid-cols-3"
          data-testid="hub"
        >
          {sections.reports && (
            <HubCard
              href={`/${locale}/customers/${customerId}/analysis/reports`}
              testid="hub-link-reports"
              title={tA("common.securityReports")}
              description={tA("customerHub.reportsDescription")}
            />
          )}
          {sections.threatStories && (
            <HubCard
              href={`/${locale}/customers/${customerId}/analysis/story`}
              testid="hub-link-stories"
              title={tNav("threatStories")}
              description={tA("customerHub.storiesDescription")}
            />
          )}
          {sections.suspiciousEvents && (
            <HubCard
              href={`/${locale}/customers/${customerId}/analysis/events`}
              testid="hub-link-events"
              title={tNav("suspiciousEvents")}
              description={tA("customerHub.eventsDescription")}
            />
          )}
        </div>
      ) : (
        <div
          role="status"
          data-testid="hub-empty"
          className="rounded border border-border bg-card px-4 py-3 text-sm text-muted-foreground"
        >
          {tA("customerHub.empty")}
        </div>
      )}
    </div>
  );
}

function HubCard({
  href,
  testid,
  title,
  description,
}: {
  href: string;
  testid: string;
  title: string;
  description: string;
}) {
  return (
    <Link
      href={href}
      data-testid={testid}
      className="flex flex-col gap-1 rounded border border-border bg-card px-4 py-4 transition-colors hover:border-foreground"
    >
      <span className="text-sm font-semibold text-foreground">{title}</span>
      <span className="text-xs text-muted-foreground">{description}</span>
    </Link>
  );
}
