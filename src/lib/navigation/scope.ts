// Customer scope model (WS1, #390 / parent #386 "scope normalization").
//
// Cross-customer overview routes carry the active scope as a `scope` query
// param: `all` (the default — the full accessible customer set) or a comma
// list of customer ids. This module is the single source of truth for
// parsing and normalizing that param. It is framework-agnostic (no React,
// no Next) so it can run unchanged on the client (provider deriving the
// current scope from the URL) and on the server (page/loader resolving the
// scope from `searchParams` and redirecting to the canonical form).
//
// Normalization contract (parent #386):
//   - dedupe requested ids;
//   - drop ids the caller cannot access (not in the ambient accessible set);
//   - collapse an empty / garbled / all-inaccessible result to `all`;
//   - a subset that covers the entire accessible set is also `all` (so the
//     all-scope has a single canonical representation);
//   - emit a canonical (sorted, deduped) form and redirect to it so shared
//     links are stable.

/** The query-string key that carries the active scope. */
export const SCOPE_PARAM = "scope";

/** Sentinel value for the all-customers scope. */
export const SCOPE_ALL = "all";

export interface NormalizedScope {
  /** True when the active scope is the full accessible customer set. */
  isAll: boolean;
  /**
   * Resolved customer ids under the active scope: sorted, deduped, and
   * guaranteed to be a subset of the accessible set. For an all-scope this
   * is the entire accessible set (sorted).
   */
  customerIds: string[];
  /**
   * Canonical value for the `scope` query param: {@link SCOPE_ALL} for an
   * all-scope, otherwise the sorted, comma-joined subset.
   */
  canonical: string;
}

/**
 * Normalize a raw `scope` query value against the accessible customer set.
 *
 * @param raw - the raw `scope` param value (`null`/`undefined` when absent).
 * @param accessibleIds - the ambient set of customer ids the caller can
 *   access (from `/api/auth/customers`); order and duplicates do not matter.
 */
export function normalizeScope(
  raw: string | null | undefined,
  accessibleIds: Iterable<string>,
): NormalizedScope {
  const accessibleSet = new Set(accessibleIds);
  const sortedAccessible = [...accessibleSet].sort();

  const all: NormalizedScope = {
    isAll: true,
    customerIds: sortedAccessible,
    canonical: SCOPE_ALL,
  };

  if (raw == null) return all;
  const trimmed = raw.trim();
  if (trimmed === "" || trimmed.toLowerCase() === SCOPE_ALL) return all;

  const requested = trimmed
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  const seen = new Set<string>();
  const kept: string[] = [];
  for (const id of requested) {
    if (accessibleSet.has(id) && !seen.has(id)) {
      seen.add(id);
      kept.push(id);
    }
  }

  // Collapse empty / all-inaccessible / garbled, and a subset that covers
  // the whole accessible set, to the canonical all-scope. `kept` is a
  // deduped subset of the accessible set, so an equal length means an equal
  // set.
  if (kept.length === 0 || kept.length === accessibleSet.size) return all;

  kept.sort();
  return { isAll: false, customerIds: kept, canonical: kept.join(",") };
}

/**
 * Decide whether the URL's `scope` param needs to be rewritten to its
 * canonical form. Returns the canonical param value to redirect to, or
 * `null` when the current value is already canonical (no redirect needed).
 *
 * An absent param is treated as the canonical all-scope, so a bare URL (no
 * `scope`) never redirects. An explicit `?scope=all` is canonical too. A
 * non-canonical value (`c2,c1`, `c1,c1`, an inaccessible id, `garbage`,
 * uppercase `ALL`, …) yields the canonical target the caller should
 * redirect to.
 */
export function scopeRedirectTarget(
  raw: string | null | undefined,
  accessibleIds: Iterable<string>,
): string | null {
  if (raw == null) return null;
  const { canonical } = normalizeScope(raw, accessibleIds);
  return raw === canonical ? null : canonical;
}
