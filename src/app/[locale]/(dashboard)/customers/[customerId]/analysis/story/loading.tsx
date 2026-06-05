import { getTranslations } from "next-intl/server";

// WS3 (#392) — loading state for the Threat Stories list, shown while the
// server component awaits the keyset query.
export default async function ThreatStoriesLoading() {
  const t = await getTranslations("analysis");
  const tNav = await getTranslations("nav");
  return (
    <div className="mx-auto max-w-4xl px-4 py-8 sm:px-6">
      <header className="mb-6">
        <h1 className="text-2xl font-bold text-foreground">
          {tNav("threatStories")}
        </h1>
      </header>
      <div
        role="status"
        data-testid="stories-loading"
        className="rounded border border-border bg-card px-4 py-3 text-sm text-muted-foreground"
      >
        {t("lists.storiesLoading")}
      </div>
    </div>
  );
}
