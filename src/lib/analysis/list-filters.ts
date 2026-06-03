// Shared filter parsing for the customer-scoped Threat Stories and
// Suspicious Events list pages (WS3 #392). Both lists support at minimum a
// time-window filter and a priority-tier filter.
//
// Pure (no `server-only`) so the parsing can be unit-tested directly.

import type { PriorityTier } from "./priority-tier";

export const PRIORITY_TIERS: readonly PriorityTier[] = [
  "CRITICAL",
  "HIGH",
  "MEDIUM",
  "LOW",
];

export type TimeWindow = "all" | "24h" | "7d" | "30d";

export const TIME_WINDOWS: readonly TimeWindow[] = ["all", "24h", "7d", "30d"];

export const TIME_WINDOW_LABELS: Record<TimeWindow, string> = {
  all: "All time",
  "24h": "Last 24 hours",
  "7d": "Last 7 days",
  "30d": "Last 30 days",
};

const WINDOW_MS: Record<Exclude<TimeWindow, "all">, number> = {
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
};

export interface ParsedListFilters {
  priorityTier: PriorityTier | null;
  window: TimeWindow;
  /** Concrete lower bound derived from `window` (null when `all`). */
  since: Date | null;
}

export function parsePriorityTier(
  raw: string | undefined,
): PriorityTier | null {
  if (raw && (PRIORITY_TIERS as readonly string[]).includes(raw)) {
    return raw as PriorityTier;
  }
  return null;
}

export function parseTimeWindow(raw: string | undefined): TimeWindow {
  if (raw && (TIME_WINDOWS as readonly string[]).includes(raw)) {
    return raw as TimeWindow;
  }
  return "all";
}

export function windowSince(window: TimeWindow, nowMs: number): Date | null {
  if (window === "all") return null;
  return new Date(nowMs - WINDOW_MS[window]);
}

/**
 * Parse the `priority` + `window` query params into validated filters,
 * resolving the time window against `nowMs` (caller passes `Date.now()`).
 * Unknown values fall back to "no priority filter" / "all time".
 */
export function parseListFilters(
  params: { priority?: string; window?: string },
  nowMs: number,
): ParsedListFilters {
  const window = parseTimeWindow(params.window);
  return {
    priorityTier: parsePriorityTier(params.priority),
    window,
    since: windowSince(window, nowMs),
  };
}

/**
 * Build the query string for a list page link, preserving the active
 * filters and optionally appending a keyset cursor. Omits defaults so the
 * canonical "first page, no filters" URL stays bare.
 */
export function buildListQuery(opts: {
  priorityTier: PriorityTier | null;
  window: TimeWindow;
  cursor?: string | null;
}): string {
  const sp = new URLSearchParams();
  if (opts.priorityTier) sp.set("priority", opts.priorityTier);
  if (opts.window !== "all") sp.set("window", opts.window);
  if (opts.cursor) sp.set("cursor", opts.cursor);
  const qs = sp.toString();
  return qs ? `?${qs}` : "";
}
