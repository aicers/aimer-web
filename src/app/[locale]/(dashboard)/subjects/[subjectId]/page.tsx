import Link from "next/link";
import { forbidden, notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { loadCustomerHubPage } from "@/lib/analysis/customer-hub-page-loader";
import { loadGroupHubPage } from "@/lib/analysis/group-hub-page-loader";
import { getAuthPool } from "@/lib/db/client";
import { getSubjectKind } from "@/lib/db/subject-runtime-pool";
import { subjectPages } from "@/lib/navigation/routes";

interface PageProps {
  params: Promise<{
    locale: string;
    subjectId: string;
  }>;
}

// WS3 (#392) / RFC 0004 #513 — subject analysis hub. The entry point that gives
// every leaf a navigable home. A `customer` subject links its reports, threat
// stories, and suspicious events; a `group` subject (#513) surfaces **reports
// only** in v1 (no group-owned story/event artifacts exist yet). The kind is
// read once up front so the correct loader runs; an unknown subject id 404s.
export default async function SubjectHubPage({ params }: PageProps) {
  const { locale, subjectId } = await params;

  const kind = await getSubjectKind(getAuthPool(), subjectId);
  if (kind === null) notFound();
  // Await the kind-specific render so its `notFound()` / `forbidden()`
  // interrupts propagate out of this dispatcher (rather than being deferred
  // inside an unrendered child element).
  if (kind === "group") {
    return await GroupHub({ locale, subjectId });
  }
  return await CustomerHub({ locale, subjectId });
}

// Customer hub: sections render only when their permission is present; the hub
// 404s only for a non-member, and an in-scope bridge session is a real 403 via
// the `forbidden.tsx` boundary.
async function CustomerHub({
  locale,
  subjectId,
}: {
  locale: string;
  subjectId: string;
}) {
  const outcome = await loadCustomerHubPage({ customerId: subjectId });
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
              href={subjectPages.reportsIndex(locale, subjectId)}
              testid="hub-link-reports"
              title={tA("common.securityReports")}
              description={tA("customerHub.reportsDescription")}
            />
          )}
          {sections.threatStories && (
            <HubCard
              href={subjectPages.storyIndex(locale, subjectId)}
              testid="hub-link-stories"
              title={tNav("threatStories")}
              description={tA("customerHub.storiesDescription")}
            />
          )}
          {sections.suspiciousEvents && (
            <HubCard
              href={subjectPages.events(locale, subjectId)}
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

// Group hub (#513): v1 surfaces **only** the reports entry card — no
// story/event cards, since no group-owned story/event artifacts exist. The hub
// 404s for a non-member of every member, and an in-scope bridge session is a
// real 403 via the `forbidden.tsx` boundary.
async function GroupHub({
  locale,
  subjectId,
}: {
  locale: string;
  subjectId: string;
}) {
  const outcome = await loadGroupHubPage({ groupId: subjectId });
  if (outcome.kind === "unauthorized") notFound();
  if (outcome.kind === "forbidden") forbidden();

  const tA = await getTranslations("analysis");

  return (
    <div className="mx-auto max-w-4xl px-4 py-8 sm:px-6">
      <header className="mb-6">
        <h1 className="text-2xl font-bold text-foreground">
          {tA("groupHub.title")}
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {tA("groupHub.subtitle")}
        </p>
      </header>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3" data-testid="hub">
        <HubCard
          href={subjectPages.reportsIndex(locale, subjectId)}
          testid="hub-link-reports"
          title={tA("common.securityReports")}
          description={tA("groupHub.reportsDescription")}
        />
      </div>
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
