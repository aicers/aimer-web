import { getTranslations } from "next-intl/server";

// WS3 (#392) — 403 boundary for the customer hub. Rendered when the hub
// page calls `forbidden()` (an in-scope bridge session, which cannot read
// these surfaces). Reaching this boundary stamps a real 403 HTTP status.
export default async function CustomerHubForbidden() {
  const t = await getTranslations("analysis");
  return (
    <div className="mx-auto max-w-4xl px-4 py-8 sm:px-6">
      <header className="mb-6">
        <h1 className="text-2xl font-bold text-foreground">
          {t("customerHub.title")}
        </h1>
      </header>
      <div
        role="alert"
        data-testid="forbidden-banner"
        className="rounded border border-rose-400 bg-rose-50 px-4 py-3 text-sm text-rose-800"
      >
        {t("customerHub.forbidden")}
      </div>
    </div>
  );
}
