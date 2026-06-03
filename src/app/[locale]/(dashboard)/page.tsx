import { redirect } from "next/navigation";

import {
  mergeQuery,
  searchParamsToUrlSearchParams,
} from "@/lib/navigation/query";

interface PageProps {
  params: Promise<{ locale: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}

// Root home → canonical `/overview` (WS5, #394). "Home" and "Dashboard" merge
// into the cross-customer Overview, so the bare `/[locale]` landing redirects
// rather than rendering a placeholder (which would be reachable but unlinked).
// The redirect preserves the inbound query string (scope + any variant params)
// per the parent query-preservation contract — a naive `redirect("/overview")`
// would silently reset the active scope. The target page canonicalizes the
// scope itself via `loadScopePage`. Mirrors the `/dashboard` stub policy.
export default async function HomeRedirect({
  params,
  searchParams,
}: PageProps) {
  const { locale } = await params;
  const sp = (await searchParams) ?? {};
  const qs = mergeQuery(searchParamsToUrlSearchParams(sp), {});
  redirect(qs ? `/${locale}/overview?${qs}` : `/${locale}/overview`);
}
