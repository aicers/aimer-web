/**
 * Per-key expiry classification used by the environment detail UI.
 *
 * The Playwright-level color-transition coverage is deferred (see PR #202
 * "Not addressed"); this pure function is exported so the 30-day / 7-day /
 * expired thresholds remain unit-testable without a browser.
 */

export type ExpiryStatus = "none" | "ok" | "yellow" | "red" | "expired";

export interface ExpiryClassification {
  status: ExpiryStatus;
  days: number | null;
  date: Date | null;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export function classifyExpiry(
  expiresAtIso: string | null,
  nowMs: number = Date.now(),
): ExpiryClassification {
  if (!expiresAtIso) return { status: "none", days: null, date: null };
  const date = new Date(expiresAtIso);
  if (Number.isNaN(date.getTime())) {
    return { status: "none", days: null, date: null };
  }
  const diffMs = date.getTime() - nowMs;
  const days = Math.ceil(diffMs / DAY_MS);
  if (diffMs <= 0) return { status: "expired", days, date };
  if (days <= 7) return { status: "red", days, date };
  if (days <= 30) return { status: "yellow", days, date };
  return { status: "ok", days, date };
}
