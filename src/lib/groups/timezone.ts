import { isValidTimeZone } from "../datetime/format-timestamp";

// ---------------------------------------------------------------------------
// Group timezone resolution + IANA validation (#506)
// ---------------------------------------------------------------------------

/**
 * Whether `tz` is a valid IANA timezone name.
 *
 * Re-exported from the shared datetime util, which probes
 * `new Intl.DateTimeFormat(undefined, { timeZone: tz })` in a try/catch.
 * That probe is the fallback the issue requires: it does not depend on
 * `Intl.supportedValuesOf("timeZone")` (a runtime-optional API), so it
 * works in every JS runtime including the project's test runtime.
 */
export { isValidTimeZone };

/**
 * The most-common timezone among `tzs`, breaking ties DETERMINISTICALLY
 * by the lexicographically smallest IANA name (so the recommendation is
 * reproducible / testable). `tzs` must be non-empty.
 */
export function recommendMostCommonTz(tzs: string[]): string {
  if (tzs.length === 0) {
    throw new Error("recommendMostCommonTz requires a non-empty list");
  }
  const counts = new Map<string, number>();
  for (const tz of tzs) {
    counts.set(tz, (counts.get(tz) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestCount = 0;
  for (const [tz, count] of counts) {
    if (
      count > bestCount ||
      (count === bestCount && (best === null || tz < best))
    ) {
      best = tz;
      bestCount = count;
    }
  }
  // `best` is non-null: the loop runs at least once for a non-empty list.
  return best as string;
}

export type GroupTzResolution =
  | { ok: true; tz: string }
  | { ok: false; recommendedTz: string };

/**
 * Resolve a group's stored `tz` at creation from its members' timezones
 * and an optional creator-`chosen` value:
 *
 * - `chosen` provided  → adopt it (the caller validates it is a valid
 *   IANA name first).
 * - all members share one tz → auto-adopt that shared tz.
 * - members differ, no `chosen` → needs a creator choice; returns the
 *   deterministic most-common recommendation for the client to prompt
 *   with and resubmit.
 *
 * `memberTzs` must be non-empty (a group always has >= 2 members).
 */
export function resolveGroupTimezone(
  memberTzs: string[],
  chosen?: string | null,
): GroupTzResolution {
  if (chosen != null) {
    return { ok: true, tz: chosen };
  }
  const distinct = new Set(memberTzs);
  if (distinct.size === 1) {
    return { ok: true, tz: memberTzs[0] };
  }
  return { ok: false, recommendedTz: recommendMostCommonTz(memberTzs) };
}
