import { redirect } from "next/navigation";

import {
  mergeQuery,
  searchParamsToUrlSearchParams,
} from "@/lib/navigation/query";

interface PageProps {
  params: Promise<{ locale: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}

// Old stub URL → canonical home (WS2, #391). `/analysis` is replaced by the
// cross-customer `/overview` landing. The redirect preserves the inbound
// query string (scope + any report-variant params) per the parent
// query-preservation contract; the target page canonicalizes the scope
// itself. WS5 (#394) repointed the sidebar at `/overview` directly; this
// redirect is kept so bookmarked/external `/analysis` links keep working.
export default async function AnalysisRedirect({
  params,
  searchParams,
}: PageProps) {
  const { locale } = await params;
  const sp = (await searchParams) ?? {};
  const qs = mergeQuery(searchParamsToUrlSearchParams(sp), {});
  redirect(qs ? `/${locale}/overview?${qs}` : `/${locale}/overview`);
}
