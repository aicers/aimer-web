import { redirect } from "next/navigation";

import {
  mergeQuery,
  searchParamsToUrlSearchParams,
} from "@/lib/navigation/query";

interface PageProps {
  params: Promise<{ locale: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}

// Old stub URL → canonical home (WS2, #391). `/dashboard` is replaced by the
// cross-customer `/overview` landing. The redirect preserves the inbound
// query string (scope + any report-variant params) per the parent
// query-preservation contract — a naive `redirect("/overview")` would
// silently reset the active scope. The target page canonicalizes the scope
// itself via `loadScopePage`. The sidebar still points here until WS5 (#394)
// restructures it; this redirect keeps that link working.
export default async function DashboardRedirect({
  params,
  searchParams,
}: PageProps) {
  const { locale } = await params;
  const sp = (await searchParams) ?? {};
  const qs = mergeQuery(searchParamsToUrlSearchParams(sp), {});
  redirect(qs ? `/${locale}/overview?${qs}` : `/${locale}/overview`);
}
