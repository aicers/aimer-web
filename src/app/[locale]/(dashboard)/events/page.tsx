import { redirect } from "next/navigation";

import {
  mergeQuery,
  searchParamsToUrlSearchParams,
} from "@/lib/navigation/query";

interface PageProps {
  params: Promise<{ locale: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}

// Old stub URL → canonical home (WS2, #391). `/events` is replaced by the
// cross-customer `/suspicious-events` overview. The redirect preserves the
// inbound query string (`/events?scope=c1,c2` lands on
// `/suspicious-events?scope=c1,c2`) per the parent query-preservation
// contract; the target page canonicalizes the scope itself. WS5 (#394)
// repointed the sidebar at `/suspicious-events` directly; this redirect is
// kept so bookmarked/external `/events` links keep working.
export default async function EventsRedirect({
  params,
  searchParams,
}: PageProps) {
  const { locale } = await params;
  const sp = (await searchParams) ?? {};
  const qs = mergeQuery(searchParamsToUrlSearchParams(sp), {});
  redirect(
    qs ? `/${locale}/suspicious-events?${qs}` : `/${locale}/suspicious-events`,
  );
}
