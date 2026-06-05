import Link from "next/link";
import { forbidden, notFound } from "next/navigation";
import type { useTranslations } from "next-intl";
import { getTranslations } from "next-intl/server";
import { ListFilterBar } from "@/components/analysis/list-filter-bar";
import { filterBarLabels } from "@/components/analysis/list-filter-labels";
import { buildListQuery, parseListFilters } from "@/lib/analysis/list-filters";
import type { PriorityTier } from "@/lib/analysis/priority-tier";
import {
  loadStoryListPage,
  type StoryListItem,
} from "@/lib/analysis/story-list-page-loader";

type AnalysisTranslations = ReturnType<typeof useTranslations<"analysis">>;

interface PageProps {
  params: Promise<{
    locale: string;
    customerId: string;
  }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}

function firstParam(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

// WS3 (#392) — customer-scoped Threat Stories list. Sibling of the existing
// `story/{storyId}` detail page. Lists the customer's threat stories
// priority-first with server-side keyset pagination. Story detail takes no
// variant params (it defaults from env), so the row links carry none.
export default async function ThreatStoryListPage({
  params,
  searchParams,
}: PageProps) {
  const { locale, customerId } = await params;
  const sp = (await searchParams) ?? {};

  const filters = parseListFilters(
    { priority: firstParam(sp.priority), window: firstParam(sp.window) },
    Date.now(),
  );
  const cursor = firstParam(sp.cursor) ?? null;

  const outcome = await loadStoryListPage({
    customerId,
    cursor,
    priorityTier: filters.priorityTier,
    since: filters.since,
  });

  // Same mapping as the report index: non-member / non-existent → 404
  // (existence-hiding); permission- or bridge-denied → real 403.
  if (outcome.kind === "unauthorized") notFound();
  if (outcome.kind === "forbidden") forbidden();

  const { items, nextCursor } = outcome.page;
  const basePath = `/${locale}/customers/${customerId}/analysis/story`;
  const tA = await getTranslations("analysis");
  const tNav = await getTranslations("nav");

  return (
    <div className="mx-auto max-w-4xl px-4 py-8 sm:px-6">
      <header className="mb-6">
        <h1 className="text-2xl font-bold text-foreground">
          {tNav("threatStories")}
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {tA("lists.storiesSubtitle")}
        </p>
      </header>

      <ListFilterBar
        action={basePath}
        priorityTier={filters.priorityTier}
        window={filters.window}
        labels={filterBarLabels(tA)}
      />

      {items.length === 0 ? (
        <div
          role="status"
          data-testid="stories-empty"
          className="rounded border border-border bg-card px-4 py-3 text-sm text-muted-foreground"
        >
          {tA("lists.storiesEmpty")}
        </div>
      ) : (
        <ul className="space-y-2" data-testid="stories-list">
          {items.map((item) => (
            <li key={item.storyId}>
              <StoryRow
                item={item}
                locale={locale}
                customerId={customerId}
                t={tA}
              />
            </li>
          ))}
        </ul>
      )}

      {nextCursor && (
        <div className="mt-6">
          <Link
            data-testid="stories-next"
            href={`${basePath}${buildListQuery({
              priorityTier: filters.priorityTier,
              window: filters.window,
              cursor: nextCursor,
            })}`}
            className="inline-flex items-center rounded border border-border bg-card px-4 py-2 text-sm font-medium text-foreground hover:bg-muted"
          >
            {tA("common.nextPage")}
          </Link>
        </div>
      )}
    </div>
  );
}

function StoryRow({
  item,
  locale,
  customerId,
  t,
}: {
  item: StoryListItem;
  locale: string;
  customerId: string;
  t: AnalysisTranslations;
}) {
  // Story detail takes no variant params — it defaults lang/model from env.
  const href = `/${locale}/customers/${customerId}/analysis/story/${item.storyId}`;
  return (
    <Link
      href={href}
      data-testid={`story-link-${item.storyId}`}
      className="flex items-center justify-between gap-3 rounded border border-border bg-card px-4 py-3 transition-colors hover:border-foreground"
    >
      <div className="min-w-0">
        <div className="truncate text-sm font-medium text-foreground">
          {t("lists.storyLabel", { storyId: item.storyId })}
        </div>
        <div className="mt-0.5 text-xs text-muted-foreground">
          {t("lists.storyRowMeta", {
            severity: item.severityScore.toFixed(3),
            likelihood: item.likelihoodScore.toFixed(3),
          })}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {item.status === "dirty" && (
          <span
            data-testid={`story-status-${item.storyId}`}
            className="inline-flex items-center rounded-full border border-sky-300 bg-sky-50 px-2 py-0.5 text-xs font-medium text-sky-900"
          >
            {t("lists.statusUpdating")}
          </span>
        )}
        <PriorityBadge tier={item.priorityTier} />
      </div>
    </Link>
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
