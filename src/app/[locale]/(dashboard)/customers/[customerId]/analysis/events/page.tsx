import Link from "next/link";
import { forbidden, notFound } from "next/navigation";
import { ListFilterBar } from "@/components/analysis/list-filter-bar";
import {
  type EventListItem,
  loadEventListPage,
} from "@/lib/analysis/event-list-page-loader";
import { buildListQuery, parseListFilters } from "@/lib/analysis/list-filters";
import type { PriorityTier } from "@/lib/analysis/priority-tier";

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

type Variant = { lang: string; modelName: string; model: string };

// WS3 (#392) — customer-scoped Suspicious Events list. A NEW customer-level
// segment (the detail route is per-`aice_id`, but a customer-wide list spans
// many `aice_id`s). Shows ANALYZED events from `event_analysis_result`,
// priority-first with keyset pagination. Row links MUST carry the canonical
// variant params — the event detail page calls `notFound()` when
// `model_name` or `model` is absent.
export default async function SuspiciousEventListPage({
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

  const outcome = await loadEventListPage({
    customerId,
    cursor,
    priorityTier: filters.priorityTier,
    since: filters.since,
  });

  if (outcome.kind === "unauthorized") notFound();
  if (outcome.kind === "forbidden") forbidden();

  const { items, nextCursor, variant } = outcome.page;
  const basePath = `/${locale}/customers/${customerId}/analysis/events`;

  return (
    <div className="mx-auto max-w-4xl px-4 py-8 sm:px-6">
      <header className="mb-6">
        <h1 className="text-2xl font-bold text-foreground">
          Suspicious Events
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Analyzed detections for this customer, highest priority first.
        </p>
      </header>

      <ListFilterBar
        action={basePath}
        priorityTier={filters.priorityTier}
        window={filters.window}
      />

      {items.length === 0 ? (
        <div
          role="status"
          aria-label="empty-banner"
          data-testid="events-empty"
          className="rounded border border-border bg-card px-4 py-3 text-sm text-muted-foreground"
        >
          No suspicious events match the current filters.
        </div>
      ) : (
        <ul className="space-y-2" data-testid="events-list">
          {items.map((item) => (
            <li key={`${item.aiceId}:${item.eventKey}`}>
              <EventRow
                item={item}
                locale={locale}
                customerId={customerId}
                variant={variant}
              />
            </li>
          ))}
        </ul>
      )}

      {nextCursor && (
        <div className="mt-6">
          <Link
            data-testid="events-next"
            href={`${basePath}${buildListQuery({
              priorityTier: filters.priorityTier,
              window: filters.window,
              cursor: nextCursor,
            })}`}
            className="inline-flex items-center rounded border border-border bg-card px-4 py-2 text-sm font-medium text-foreground hover:bg-muted"
          >
            Next page
          </Link>
        </div>
      )}
    </div>
  );
}

function EventRow({
  item,
  locale,
  customerId,
  variant,
}: {
  item: EventListItem;
  locale: string;
  customerId: string;
  variant: Variant;
}) {
  // The event detail page 404s without `model_name`/`model` (they are part
  // of the storage PK), defaulting only `lang`. Carry the canonical
  // variant's params so the link resolves instead of 404ing.
  const query = new URLSearchParams({
    lang: variant.lang,
    model_name: variant.modelName,
    model: variant.model,
  }).toString();
  const href = `/${locale}/customers/${customerId}/aice/${encodeURIComponent(
    item.aiceId,
  )}/events/${encodeURIComponent(item.eventKey)}/analysis?${query}`;

  return (
    <Link
      href={href}
      data-testid={`event-link-${item.aiceId}-${item.eventKey}`}
      className="flex items-center justify-between gap-3 rounded border border-border bg-card px-4 py-3 transition-colors hover:border-foreground"
    >
      <div className="min-w-0">
        <div className="truncate text-sm font-medium text-foreground">
          Event {item.eventKey}
        </div>
        <div className="mt-0.5 text-xs text-muted-foreground">
          {item.aiceId} • severity {item.severityScore.toFixed(3)} • likelihood{" "}
          {item.likelihoodScore.toFixed(3)}
        </div>
      </div>
      <PriorityBadge tier={item.priorityTier} />
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
