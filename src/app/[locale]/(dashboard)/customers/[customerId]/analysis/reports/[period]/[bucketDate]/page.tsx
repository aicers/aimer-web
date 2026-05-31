import { forbidden, notFound } from "next/navigation";
import type { PriorityTier } from "@/lib/analysis/priority-tier";
import {
  isValidBucketDate,
  LIVE_BUCKET_DATE,
} from "@/lib/analysis/report-bucket-date";
import {
  loadReportResultPage,
  type ReportSections,
} from "@/lib/analysis/report-result-page-loader";
import { getCurrentTimestamp } from "@/lib/instrumentation/time";
import { ReportRegenerateButton } from "./regenerate-button";
import { ReportPeriodTabs } from "./report-period-tabs";

interface PageProps {
  params: Promise<{
    locale: string;
    customerId: string;
    period: string;
    bucketDate: string;
  }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}

// Collapse a possibly-repeated search param to its first scalar value.
function firstParam(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

// The calendar day the period tabs anchor their cross-period links to.
// For a calendar period the bucket_date IS that day; LIVE carries the
// synthetic epoch bucket, so anchor the other tabs on "today" in the
// resolved report tz instead — otherwise every non-LIVE tab would point
// at 1970. The tz must be the timezone the loader resolved (pinned
// variant → customer default → UTC), NOT the raw `?tz` query value: a
// default LIVE URL has no `?tz`, and falling back to UTC there would
// anchor an Asia/Seoul customer's tabs on the wrong calendar day around
// the UTC date boundary.
function tabReferenceDate(
  period: string,
  bucketDate: string,
  tz: string | undefined,
): string {
  if (period !== "LIVE") return bucketDate;
  return formatDayInTz(getCurrentTimestamp(), tz);
}

// Format `at` as a `YYYY-MM-DD` calendar day in `tz`. A malformed tz
// makes `Intl.DateTimeFormat` throw `RangeError`; swallow it and fall
// back to UTC so a bad pinned `?tz` cannot 500 the detail page (the
// loader already turns an unmatched tz into the usual not-found/pending
// outcome).
function formatDayInTz(at: Date, tz: string | undefined): string {
  const opts: Intl.DateTimeFormatOptions = {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  };
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: tz || "UTC",
      ...opts,
    }).format(at);
  } catch {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: "UTC",
      ...opts,
    }).format(at);
  }
}

// UPPERCASE only (case lock): a lowercase period in the URL is a 404,
// not a case-insensitive redirect, so the UI route and the API path
// validation share one case convention.
const PERIODS = new Set(["LIVE", "DAILY", "WEEKLY", "MONTHLY"]);

export default async function ReportDetailPage({
  params,
  searchParams,
}: PageProps) {
  const { locale, customerId, period, bucketDate } = await params;
  const sp = (await searchParams) ?? {};

  if (!PERIODS.has(period)) notFound();
  // Calendar-valid check (not just the YYYY-MM-DD shape) so an impossible
  // date like 2026-02-31 is a 404 here rather than a 500 from the loader's
  // `$3::date` cast (#297 review round 5, item 2).
  if (!isValidBucketDate(bucketDate)) notFound();
  if (period === "LIVE" && bucketDate !== LIVE_BUCKET_DATE) notFound();

  // Forward the active report variant (if pinned via the query string) so a
  // non-default report opens, displays, and regenerates as that variant.
  const variant = {
    tz: firstParam(sp.tz),
    lang: firstParam(sp.lang),
    model_name: firstParam(sp.model_name),
    model: firstParam(sp.model),
  };

  const outcome = await loadReportResultPage({
    customerId,
    period,
    bucketDate,
    variant,
  });

  // Non-member / non-existent → 404 (existence-hiding). Permission- or
  // bridge-denied → 403 (round-15 S3). `forbidden()` (enabled via
  // `experimental.authInterrupts`) interrupts rendering with a real 403
  // and renders the nearest `forbidden.tsx` boundary — the page response
  // is no longer a 200 that merely looks denied (#297 review round 4,
  // item 1).
  if (outcome.kind === "unauthorized" || outcome.kind === "not_found") {
    notFound();
  }
  if (outcome.kind === "forbidden") {
    forbidden();
  }

  // Build the tab bar only now that the loader has resolved the report
  // timezone (the only remaining outcomes — `pending` and `ok` — both
  // carry it). The LIVE tab anchors its cross-period links on "today" in
  // that resolved tz, so this must run after the loader rather than off
  // the raw `?tz` query value.
  const resolvedTz = outcome.kind === "ok" ? outcome.data.tz : outcome.tz;
  const tabs = (
    <ReportPeriodTabs
      locale={locale}
      customerId={customerId}
      activePeriod={period}
      referenceDate={tabReferenceDate(period, bucketDate, resolvedTz)}
      variant={variant}
    />
  );

  if (outcome.kind === "pending") {
    return (
      <div className="mx-auto max-w-4xl px-4 py-8 sm:px-6">
        <header className="mb-6">
          <h1 className="text-2xl font-bold text-foreground">
            Security Report
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {period} • {bucketDate}
          </p>
        </header>
        <div className="mb-6">{tabs}</div>
        <div
          role="status"
          aria-label="pending-banner"
          className="rounded border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900"
        >
          The report is being generated (state: {outcome.stateStatus}). Refresh
          once the result is ready.
        </div>
      </div>
    );
  }

  const data = outcome.data;

  return (
    <div className="mx-auto max-w-4xl px-4 py-8 sm:px-6">
      <header className="mb-6">
        <h1 className="text-2xl font-bold text-foreground">Security Report</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {data.period === "LIVE" ? "LIVE (rolling)" : data.period} •{" "}
          {data.period === "LIVE" ? "now" : data.bucketDate} • {data.tz} •
          generation {data.generation}
        </p>
      </header>

      <div className="mb-6">{tabs}</div>

      <section className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label="Priority tier">
          <div className="flex flex-wrap items-center gap-2">
            <PriorityBadge tier={data.priorityTier} />
            <TtpChipRow tags={data.ttpTags} />
          </div>
        </Field>
        <Field label="Aggregate scores">
          <div data-testid="aggregate-scores">
            severity {data.aggregateSeverityScore.toFixed(3)} • likelihood{" "}
            {data.aggregateLikelihoodScore.toFixed(3)}
          </div>
          <div className="mt-1 text-xs text-muted-foreground">
            Aggregated by aimer-web from {data.topStoryCount} stor
            {data.topStoryCount === 1 ? "y" : "ies"} and {data.topEventCount}{" "}
            event{data.topEventCount === 1 ? "" : "s"} plus baseline drift.
          </div>
        </Field>
        <Field label="Language">{data.lang}</Field>
        <Field label="Model">
          {data.modelName} / {data.model}
        </Field>
        <Field label="Model snapshot">{data.modelActualVersion}</Field>
        <Field label="Prompt version">{data.promptVersion}</Field>
        <Field label="Requested by">{data.requestedBy ?? "system"}</Field>
        <Field label="Requested at">{data.requestedAt.toISOString()}</Field>
      </section>

      <ReportSection
        title="Executive summary"
        body={data.sections.executive_summary}
        testid="section-executive_summary"
      />
      <ReportSection
        title="Story highlights"
        body={data.sections.story_highlights}
        testid="section-story_highlights"
      />
      <ReportSection
        title="Notable events"
        body={data.sections.notable_events}
        testid="section-notable_events"
      />
      <ReportSection
        title="Baseline observations"
        body={data.sections.baseline_observations}
        testid="section-baseline_observations"
      />
      <ReportSection
        title="Period outlook"
        body={data.sections.period_outlook}
        testid="section-period_outlook"
      />

      <section className="mt-8">
        <ReportRegenerateButton
          customerId={data.customerId}
          period={data.period}
          bucketDate={data.bucketDate}
          variant={{
            tz: data.tz,
            lang: data.lang,
            model_name: data.modelName,
            model: data.model,
          }}
        />
      </section>
    </div>
  );
}

function ReportSection({
  title,
  body,
  testid,
}: {
  title: string;
  body: string;
  testid: keyof ReportSections | string;
}) {
  return (
    <section className="mt-8">
      <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
        {title}
      </h2>
      <div
        data-testid={testid}
        className="whitespace-pre-wrap rounded border border-border bg-card px-4 py-3 text-sm text-foreground"
      >
        {body || "—"}
      </div>
    </section>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div className="mt-1 text-sm text-foreground">{children}</div>
    </div>
  );
}

const TIER_CLASSES: Record<PriorityTier, string> = {
  CRITICAL: "border-rose-500 bg-rose-100 text-rose-900",
  HIGH: "border-orange-400 bg-orange-100 text-orange-900",
  MEDIUM: "border-amber-300 bg-amber-50 text-amber-900",
  LOW: "border-slate-300 bg-slate-50 text-slate-700",
};

function PriorityBadge({ tier }: { tier: PriorityTier }) {
  return (
    <span
      data-testid="priority-tier-badge"
      data-tier={tier}
      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-semibold ${TIER_CLASSES[tier]}`}
    >
      {tier}
    </span>
  );
}

function TtpChipRow({
  tags,
}: {
  tags: ReadonlyArray<{ id: string; name: string | null }>;
}) {
  if (tags.length === 0) return null;
  return (
    <ul
      aria-label="ttp-tags"
      data-testid="ttp-tags"
      className="flex flex-wrap gap-1"
    >
      {tags.map((tag) => (
        <li
          key={tag.id}
          title={tag.name ?? undefined}
          data-tag-id={tag.id}
          className="inline-flex items-center rounded-full border border-indigo-300 bg-indigo-50 px-2 py-0.5 text-xs font-medium text-indigo-900"
        >
          {tag.id}
        </li>
      ))}
    </ul>
  );
}
