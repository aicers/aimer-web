// Shared breadcrumb-label formatting for dynamic leaf segments.
//
// The leaf loaders (story / event) expose IDs, not human-readable
// titles, so the agreed label is a terminology word plus a shortened id
// (#393 "Open question"): e.g. `Threat Story · 1f3c9a2b…`. This module is
// the single source of that format so the client `<Breadcrumbs />`
// fallback and the server-rendered `<BreadcrumbLabelRegistrar />` produce
// the identical string — the only difference is where the id comes from
// (route param vs already-loaded page data, no refetch either way).

// First 8 characters, with an ellipsis when truncated. Enough to
// disambiguate without dumping a full UUID into the trail.
export function shortCrumbId(id: string): string {
  return id.length > 8 ? `${id.slice(0, 8)}…` : id;
}

// `<term> · <short-id>` — the terminology + short-id fallback. `term` is
// the already-localized noun ("Threat Story" / "Event"), so this stays
// framework-agnostic (callable from both client and server components).
export function entityCrumbLabel(term: string, id: string): string {
  return `${term} · ${shortCrumbId(id)}`;
}
