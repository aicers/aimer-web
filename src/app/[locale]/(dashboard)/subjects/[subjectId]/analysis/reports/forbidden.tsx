// #369 — 403 boundary for the report index page.
//
// Rendered by Next when the index page calls `forbidden()` (a permission-
// or bridge-denied read). Reaching this boundary stamps a real 403 HTTP
// status on the response, matching the detail page's denial contract
// (member-without-`reports:read` → 403, bridge → 403). The route's own
// params are not available to a boundary file, so the message is
// variant-agnostic. The more specific `[period]/[bucketDate]/forbidden.tsx`
// still wins for the detail subtree.

import { getTranslations } from "next-intl/server";

export default async function ReportsForbidden() {
  const t = await getTranslations("analysis");
  return (
    <div className="mx-auto max-w-4xl px-4 py-8 sm:px-6">
      <header className="mb-6">
        <h1 className="text-2xl font-bold text-foreground">
          {t("common.securityReports")}
        </h1>
      </header>
      <div
        role="alert"
        data-testid="forbidden-banner"
        className="rounded border border-rose-400 bg-rose-50 px-4 py-3 text-sm text-rose-800"
      >
        {t.rich("boundaries.reportsForbidden", {
          code: (chunks) => <code>{chunks}</code>,
        })}
      </div>
    </div>
  );
}
