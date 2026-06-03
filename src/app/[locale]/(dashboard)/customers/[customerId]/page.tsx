import Link from "next/link";
import { forbidden, notFound } from "next/navigation";
import {
  type CustomerHubSections,
  loadCustomerHubPage,
} from "@/lib/analysis/customer-hub-page-loader";

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

  return (
    <div className="mx-auto max-w-4xl px-4 py-8 sm:px-6">
      <header className="mb-6">
        <h1 className="text-2xl font-bold text-foreground">Customer</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Reports and analysis for this customer.
        </p>
      </header>

      {anySection ? (
        <div
          className="grid grid-cols-1 gap-4 sm:grid-cols-3"
          data-testid="hub"
        >
          <HubCards
            locale={locale}
            customerId={customerId}
            sections={sections}
          />
        </div>
      ) : (
        <div
          role="status"
          aria-label="empty-banner"
          data-testid="hub-empty"
          className="rounded border border-border bg-card px-4 py-3 text-sm text-muted-foreground"
        >
          You do not have access to any sections for this customer.
        </div>
      )}
    </div>
  );
}

function HubCards({
  locale,
  customerId,
  sections,
}: {
  locale: string;
  customerId: string;
  sections: CustomerHubSections;
}) {
  const base = `/${locale}/customers/${customerId}`;
  return (
    <>
      {sections.reports && (
        <HubCard
          href={`${base}/analysis/reports`}
          testid="hub-link-reports"
          title="Security Reports"
          description="Periodic report buckets for this customer."
        />
      )}
      {sections.threatStories && (
        <HubCard
          href={`${base}/analysis/story`}
          testid="hub-link-stories"
          title="Threat Stories"
          description="Pre-curated correlations of suspicious events."
        />
      )}
      {sections.suspiciousEvents && (
        <HubCard
          href={`${base}/analysis/events`}
          testid="hub-link-events"
          title="Suspicious Events"
          description="Analyzed detections forwarded for this customer."
        />
      )}
    </>
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
