// Feature gate for the retroactive re-redact job.
//
// #252 ships the CRUD + preview pieces; #253 supplies the worker that
// processes the job rows. To prevent inert rows during the window
// where #252 has landed but #253 has not, both the UI button and the
// trigger endpoint are gated behind a single env-driven flag. #253's
// PR flips this to "on".
//
// The env var is `NEXT_PUBLIC_*` so the same value is observable from
// both the server (trigger endpoint, this file) and the client bundle
// (the Apply button in `RedactionRangesSection`). That keeps the
// documented "same gate" invariant: flipping one variable enables both
// sides at once, and the UI never offers an action the server would
// refuse with 503.
//
// Off by default — explicit opt-in keeps merge order safe.

const ENABLED_VALUES = new Set(["1", "true", "yes", "on"]);

function parseFlag(raw: string | undefined): boolean {
  if (!raw) return false;
  return ENABLED_VALUES.has(raw.trim().toLowerCase());
}

export function isRedactionJobsEnabled(): boolean {
  return parseFlag(process.env.NEXT_PUBLIC_REDACTION_RETROACTIVE_ENABLED);
}

/**
 * Heuristic per-row processing cost used to estimate the worker's
 * duration. The constant lives in #253's worker once that lands;
 * exporting it from here for now lets #252's preview endpoint return a
 * usable estimate without taking a hard dependency on the
 * (not-yet-merged) worker module.
 */
export const PER_ROW_SECONDS = 0.05;
