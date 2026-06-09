"use client";

import { useTranslations } from "next-intl";

// WS3 (#392) — error state for the Suspicious Events list. A client
// boundary rendered when the server component throws (e.g. the keyset query
// fails).
export default function SuspiciousEventsError({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const t = useTranslations("analysis");
  const tNav = useTranslations("nav");
  return (
    <div className="mx-auto max-w-4xl px-4 py-8 sm:px-6">
      <header className="mb-6">
        <h1 className="text-2xl font-bold text-foreground">
          {tNav("suspiciousEvents")}
        </h1>
      </header>
      <div
        role="alert"
        data-testid="events-error"
        className="rounded border border-rose-400 bg-rose-50 px-4 py-3 text-sm text-rose-800"
      >
        <p>{t("lists.eventsError")}</p>
        <button
          type="button"
          onClick={reset}
          className="mt-2 inline-flex items-center rounded border border-rose-300 bg-white px-3 py-1.5 text-sm font-medium text-rose-800 hover:bg-rose-100"
        >
          {t("common.tryAgain")}
        </button>
      </div>
    </div>
  );
}
