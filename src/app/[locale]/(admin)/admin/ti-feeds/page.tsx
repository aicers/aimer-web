import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";

import {
  selfFetchModeActive,
  tiFeedAdminSurfaceActive,
} from "@/lib/analysis/enrichment/feed-fetch";
import { TiFeedsPage } from "./ti-feeds-page";

export default async function Page() {
  // The shared Threat Feeds surface exists in `manual-upload` OR `self-fetch`.
  if (!tiFeedAdminSurfaceActive()) {
    notFound();
  }

  const selfFetch = selfFetchModeActive();
  const t = await getTranslations("adminTiFeeds");
  return (
    <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6">
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-foreground">{t("title")}</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {selfFetch ? t("descriptionSelfFetch") : t("description")}
        </p>
      </div>
      <TiFeedsPage selfFetch={selfFetch} />
    </div>
  );
}
