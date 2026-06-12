import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";

import { manualUploadModeActive } from "@/lib/analysis/enrichment/feed-upload";
import { TiFeedsPage } from "./ti-feeds-page";

export default async function Page() {
  // The manual-upload surface only exists in `TI_FEED_MODE=manual-upload`.
  if (!manualUploadModeActive()) {
    notFound();
  }

  const t = await getTranslations("adminTiFeeds");
  return (
    <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6">
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-foreground">{t("title")}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{t("description")}</p>
      </div>
      <TiFeedsPage />
    </div>
  );
}
