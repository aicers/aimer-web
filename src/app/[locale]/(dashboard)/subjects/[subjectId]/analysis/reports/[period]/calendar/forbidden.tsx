// RFC 0004 (#505) — 403 boundary for the report calendar page.
//
// Rendered by Next when the page calls `forbidden()` (a permission- or
// bridge-denied read), stamping a real 403 on the response. Mirrors the
// detail page's boundary; the route's params are not available here, so the
// message is variant-agnostic.

import { getTranslations } from "next-intl/server";

export default async function ReportCalendarForbidden() {
  const t = await getTranslations("analysis");
  return (
    <div className="mx-auto max-w-4xl px-4 py-8 sm:px-6">
      <header className="mb-6">
        <h1 className="text-2xl font-bold text-foreground">
          {t("reportCalendar.title")}
        </h1>
      </header>
      <div
        role="alert"
        data-testid="forbidden-banner"
        className="rounded border border-rose-400 bg-rose-50 px-4 py-3 text-sm text-rose-800"
      >
        {t.rich("boundaries.reportForbidden", {
          code: (chunks) => <code>{chunks}</code>,
        })}
      </div>
    </div>
  );
}
