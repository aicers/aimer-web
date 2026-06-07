import { forbidden, notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { CitedReportSection } from "@/components/analysis/cited-report-section";
import { SourcesPanel } from "@/components/analysis/sources-panel";
import { AnalysisBody } from "@/components/analysis-body";
import { Timestamp } from "@/components/timestamp";
import { type AppLocale, reportLanguageToAppLocale } from "@/i18n/locale";
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
import {
  mergeQuery,
  searchParamsToUrlSearchParams,
} from "@/lib/navigation/query";
import { ReportRegenerateButton } from "./regenerate-button";
import { ReportLanguageStatus } from "./report-language-status";
import { ReportLanguageSwitcher } from "./report-language-switcher";
import { ReportPeriodTabs } from "./report-period-tabs";

// The app locales offered by the language switcher, in display order.
const SWITCHER_LOCALES: readonly AppLocale[] = ["en", "ko"];

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
  // `lang` is now an app-locale code (`en`/`ko`), validated in the loader;
  // `locale` (the route param) is the viewer-preference default.
  const variant = {
    tz: firstParam(sp.tz),
    lang: firstParam(sp.lang),
    model_name: firstParam(sp.model_name),
    model: firstParam(sp.model),
  };

  // Optional generation pin (T2 "Cited by" link). A present-but-invalid
  // value 404s rather than silently resolving the latest generation
  // (parent #386 generation-pin contract).
  let generation: number | undefined;
  const rawGeneration = firstParam(sp.generation);
  if (rawGeneration !== undefined) {
    const n = Number(rawGeneration);
    if (!Number.isInteger(n) || n <= 0) notFound();
    generation = n;
  }

  const outcome = await loadReportResultPage({
    customerId,
    period,
    bucketDate,
    locale,
    variant,
    generation,
  });

  // The page's current query string, preserved across the tabs and the
  // language switcher via the shared `mergeQuery` helper. A `generation`
  // pin (T2 "Cited by" deep-link) is intentionally dropped here: it is
  // specific to this exact bucket + variant, so carrying it onto a period
  // tab (a different bucket) or the language switcher (a different variant)
  // would almost always resolve to "report version no longer available".
  // Ambient navigation shows the latest generation of its target; the
  // Sources / Cited-by links set `generation` explicitly when a pin is
  // wanted.
  const currentQuery = mergeQuery(searchParamsToUrlSearchParams(sp), {
    generation: null,
  });

  const tA = await getTranslations("analysis");
  const tPeriod = await getTranslations("reportPeriod");
  // Translated period labels (`reportPeriod`), reused for the tab bar and
  // the header badge. The header subtitle historically rendered the raw
  // uppercase enum (`WEEKLY`); uppercasing the translated value keeps the
  // English byte-for-byte while localizing KO.
  const periodLabels: Record<string, string> = {
    LIVE: tPeriod("LIVE"),
    DAILY: tPeriod("DAILY"),
    WEEKLY: tPeriod("WEEKLY"),
    MONTHLY: tPeriod("MONTHLY"),
  };
  const subtitlePeriod = (periodLabels[period] ?? period).toUpperCase();

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
  if (outcome.kind === "pin_unavailable") {
    // A "Cited by" link pinned a generation that is gone/superseded. Show
    // the same "evidence version no longer available" notice the leaf
    // pages use — never silently fall back to the latest generation.
    return (
      <div className="mx-auto max-w-4xl px-4 py-8 sm:px-6">
        <header className="mb-6">
          <h1 className="text-2xl font-bold text-foreground">
            {tA("reportDetail.title")}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {tA("reportDetail.subtitlePinUnavailable", {
              period: subtitlePeriod,
              bucketDate,
              generation: outcome.generation,
            })}
          </p>
        </header>
        <div
          role="status"
          data-testid="pin-unavailable-banner"
          className="rounded border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900"
        >
          {tA("reportDetail.pinUnavailableBanner")}
        </div>
      </div>
    );
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
      currentQuery={currentQuery}
      periodLabels={periodLabels}
      navLabel={tA("reportDetail.periodNavLabel")}
    />
  );

  if (outcome.kind === "pending") {
    return (
      <div className="mx-auto max-w-4xl px-4 py-8 sm:px-6">
        <header className="mb-6">
          <h1 className="text-2xl font-bold text-foreground">
            {tA("reportDetail.title")}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {tA("reportDetail.subtitlePending", {
              period: subtitlePeriod,
              bucketDate,
            })}
          </p>
        </header>
        <div className="mb-6">{tabs}</div>
        <div
          role="status"
          data-testid="pending-banner"
          className="rounded border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900"
        >
          {tA("reportDetail.pendingBanner", { status: outcome.stateStatus })}
        </div>
      </div>
    );
  }

  const data = outcome.data;
  const t = await getTranslations("reports");
  // Localized language name by app-locale code (literal keys — the message
  // catalog is statically typed, so dynamic key paths are not allowed).
  const localeName = (loc: AppLocale): string =>
    loc === "en" ? t("languageName.en") : t("languageName.ko");

  // Language switcher: offer every supported locale, marking which already
  // have a stored result. The currently-shown language is the row's actual
  // `lang` mapped back to a locale code.
  const shownLocale = reportLanguageToAppLocale(
    data.lang === "KOREAN" ? "KOREAN" : "ENGLISH",
  );
  const basePath = `/${locale}/customers/${customerId}/analysis/reports/${period}/${bucketDate}`;
  const switcher = (
    <ReportLanguageSwitcher
      label={t("languageSwitcherLabel")}
      navLabel={tA("reportDetail.languageNavLabel")}
      basePath={basePath}
      currentQuery={currentQuery}
      currentLocale={shownLocale}
      languages={SWITCHER_LOCALES.map((loc) => ({
        locale: loc,
        name: localeName(loc),
        available: data.availableLocales.includes(loc),
      }))}
    />
  );

  // Fallback notice + phase-2 on-demand status, only when the shown report
  // fell back from the requested language.
  let languageNotice: React.ReactNode = null;
  if (data.languageFallback) {
    const requestedName = localeName(data.languageFallback.requestedLocale);
    const statusUrl = `/api/customers/${customerId}/analysis/report/${period}/${bucketDate}/language-status?${mergeQuery(
      "",
      {
        tz: data.tz,
        lang: data.languageFallback.requestedLocale,
        model_name: data.modelName,
        model: data.model,
      },
    )}`;
    languageNotice = (
      <div className="mt-4 space-y-2">
        <div
          role="status"
          data-testid="report-language-fallback"
          className="rounded border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900"
        >
          {t("fallbackNotice", { language: requestedName })}
        </div>
        {data.languageFallback.jobStatus !== null ? (
          <ReportLanguageStatus
            statusUrl={statusUrl}
            initialStatus={data.languageFallback.jobStatus}
            labels={{
              preparing: t("jobPreparing", { language: requestedName }),
              failed: t("jobFailed", { language: requestedName }),
              pendingSource: t("jobPendingSource", { language: requestedName }),
            }}
          />
        ) : null}
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-4xl px-4 py-8 sm:px-6">
      <header className="mb-6">
        <h1 className="text-2xl font-bold text-foreground">
          {tA("reportDetail.title")}
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {tA("reportDetail.subtitle", {
            period:
              data.period === "LIVE"
                ? tA("reportDetail.liveRolling", {
                    period: periodLabels.LIVE.toUpperCase(),
                  })
                : (periodLabels[data.period] ?? data.period).toUpperCase(),
            when: data.period === "LIVE" ? tA("common.now") : data.bucketDate,
            tz: data.tz,
            generation: data.generation,
          })}
        </p>
      </header>

      <div className="mb-2">{tabs}</div>
      <div className="mb-6 flex items-center justify-end">{switcher}</div>
      {languageNotice}

      <section className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label={tA("fields.priorityTier")}>
          <div className="flex flex-wrap items-center gap-2">
            <PriorityBadge tier={data.priorityTier} />
            <TtpChipRow tags={data.ttpTags} ariaLabel={tA("common.ttpTags")} />
          </div>
          <div
            className="mt-1 text-xs text-muted-foreground"
            data-testid="aggregate-hint"
          >
            {tA("reportDetail.aggregateHint", {
              storyCount: data.topStoryCount,
              eventCount: data.topEventCount,
            })}
          </div>
        </Field>
        <Field label={tA("fields.aggregateScores")}>
          <div data-testid="aggregate-scores">
            {tA("common.severityLikelihood", {
              severity: data.aggregateSeverityScore.toFixed(3),
              likelihood: data.aggregateLikelihoodScore.toFixed(3),
            })}
          </div>
        </Field>
        <Field label={tA("fields.language")}>{data.lang}</Field>
        {/* Model/prompt provenance is operator-facing detail about how the
            artifact was produced — restricted to analysts (#457). A
            non-analyst keeps every analytically-meaningful field above. */}
        {data.isViewerAnalyst ? (
          <>
            <Field label={tA("fields.model")}>
              {data.modelName} / {data.model}
            </Field>
            <Field label={tA("fields.modelSnapshot")}>
              {data.modelActualVersion}
            </Field>
            <Field label={tA("fields.promptVersion")}>
              {data.promptVersion}
            </Field>
            <Field label={tA("fields.requestedBy")}>
              {data.requestedBy ?? tA("common.system")}
            </Field>
            <Field label={tA("fields.requestedAt")}>
              <Timestamp at={data.requestedAt} />
            </Field>
          </>
        ) : null}
      </section>

      {/* Leaf-derived sections carry per-unit (sentence-level) citations
          (#449): each render unit links to the single leaf it was derived
          from, generation-pinned. Uncited units render without a dangling
          link. */}
      <CitedReportSection
        title={tA("reportDetail.sectionExecutiveSummary")}
        units={data.sections.executive_summary}
        locale={locale}
        customerId={customerId}
        testid="section-executive_summary"
        t={tA}
      />
      <CitedReportSection
        title={tA("reportDetail.sectionStoryHighlights")}
        units={data.sections.story_highlights}
        locale={locale}
        customerId={customerId}
        testid="section-story_highlights"
        t={tA}
      />
      <CitedReportSection
        title={tA("reportDetail.sectionNotableEvents")}
        units={data.sections.notable_events}
        locale={locale}
        customerId={customerId}
        testid="section-notable_events"
        t={tA}
      />

      {/* Report-level cited sources for the leaf-derived sections above
          (executive summary / story highlights / notable events). Placed
          before the suspicious-event trends section, which is the
          drill-down's deliberate stopping point and gets no Sources panel
          (#395). */}
      <SourcesPanel
        locale={locale}
        customerId={customerId}
        sources={data.citedSources}
        t={tA}
      />

      <ReportSection
        title={tA("reportDetail.sectionSuspiciousEventTrends")}
        body={data.sections.baseline_observations}
        testid="section-baseline_observations"
      />
      <ReportSection
        title={tA("reportDetail.sectionPeriodOutlook")}
        body={data.sections.period_outlook}
        testid="section-period_outlook"
      />

      {/* Force-regenerate is an analyst-only action (the endpoint authorizes
          `reports:create`). Gate the button so the UI matches that server
          authorization — bridge reads never reach this page, so the
          analyst flag alone suffices here (#457). */}
      {data.isViewerAnalyst ? (
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
      ) : null}
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
      <AnalysisBody text={body} testid={testid} emptyFallback="—" />
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
  ariaLabel,
}: {
  tags: ReadonlyArray<{ id: string; name: string | null }>;
  ariaLabel: string;
}) {
  if (tags.length === 0) return null;
  return (
    <ul
      aria-label={ariaLabel}
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
