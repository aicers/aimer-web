import { notFound } from "next/navigation";
import type { PriorityTier } from "@/lib/analysis/priority-tier";
import {
  loadReportResultPage,
  type ReportSections,
} from "@/lib/analysis/report-result-page-loader";
import { ReportRegenerateButton } from "./regenerate-button";

interface PageProps {
  params: Promise<{
    locale: string;
    customerId: string;
    period: string;
    bucketDate: string;
  }>;
}

// UPPERCASE only (case lock): a lowercase period in the URL is a 404,
// not a case-insensitive redirect, so the UI route and the API path
// validation share one case convention.
const PERIODS = new Set(["LIVE", "DAILY", "WEEKLY", "MONTHLY"]);
const PHASE2_PERIODS = new Set(["LIVE", "DAILY"]);
const BUCKET_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const LIVE_BUCKET_DATE = "1970-01-01";

export default async function ReportDetailPage({ params }: PageProps) {
  const { customerId, period, bucketDate } = await params;

  if (!PERIODS.has(period)) notFound();
  if (!BUCKET_DATE_RE.test(bucketDate)) notFound();
  if (period === "LIVE" && bucketDate !== LIVE_BUCKET_DATE) notFound();
  // WEEKLY/MONTHLY are not produced in Phase 2 — no report to show yet.
  if (!PHASE2_PERIODS.has(period)) notFound();

  const outcome = await loadReportResultPage({
    customerId,
    period,
    bucketDate,
  });

  if (outcome.kind === "unauthorized" || outcome.kind === "not_found") {
    notFound();
  }
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
        title="Baseline drift"
        body={data.sections.baseline_drift}
        testid="section-baseline_drift"
      />
      <ReportSection
        title="Notable events"
        body={data.sections.notable_events}
        testid="section-notable_events"
      />
      <ReportSection
        title="Recommendations"
        body={data.sections.recommendations}
        testid="section-recommendations"
      />

      <section className="mt-8">
        <ReportRegenerateButton
          customerId={data.customerId}
          period={data.period}
          bucketDate={data.bucketDate}
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
