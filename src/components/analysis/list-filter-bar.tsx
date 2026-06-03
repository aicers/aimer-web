import {
  PRIORITY_TIERS,
  TIME_WINDOW_LABELS,
  TIME_WINDOWS,
  type TimeWindow,
} from "@/lib/analysis/list-filters";
import type { PriorityTier } from "@/lib/analysis/priority-tier";

// Shared filter bar for the WS3 (#392) Threat Stories / Suspicious Events
// list pages. A plain GET form so it works without client JS: submitting
// navigates to the same path with `?priority=&window=`, re-rendering the
// server page. The cursor is intentionally NOT a form field — changing a
// filter resets pagination to the first page, which is the correct keyset
// behavior.
export function ListFilterBar({
  action,
  priorityTier,
  window,
}: {
  /** Path the form submits to (the list page's own path). */
  action: string;
  priorityTier: PriorityTier | null;
  window: TimeWindow;
}) {
  return (
    <form
      method="get"
      action={action}
      data-testid="list-filter-bar"
      className="mb-6 flex flex-wrap items-end gap-3"
    >
      <label className="flex flex-col gap-1 text-xs font-medium text-muted-foreground">
        Priority
        <select
          name="priority"
          defaultValue={priorityTier ?? ""}
          className="rounded border border-border bg-card px-2 py-1 text-sm text-foreground"
        >
          <option value="">All</option>
          {PRIORITY_TIERS.map((tier) => (
            <option key={tier} value={tier}>
              {tier}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1 text-xs font-medium text-muted-foreground">
        Time window
        <select
          name="window"
          defaultValue={window}
          className="rounded border border-border bg-card px-2 py-1 text-sm text-foreground"
        >
          {TIME_WINDOWS.map((w) => (
            <option key={w} value={w}>
              {TIME_WINDOW_LABELS[w]}
            </option>
          ))}
        </select>
      </label>
      <button
        type="submit"
        className="rounded border border-border bg-card px-3 py-1.5 text-sm font-medium text-foreground hover:bg-muted"
      >
        Apply
      </button>
    </form>
  );
}
