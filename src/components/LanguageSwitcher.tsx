"use client";

import { useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { useTransition } from "react";
import { locales, usePathname, useRouter } from "@/i18n/navigation";

export function LanguageSwitcher() {
  const t = useTranslations();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [isPending, startTransition] = useTransition();
  const firstSegment = pathname.split("/")[1] ?? "";
  const currentLocale = (locales as readonly string[]).includes(firstSegment)
    ? (firstSegment as (typeof locales)[number])
    : locales[0];

  return (
    <label className="text-sm flex items-center gap-2">
      <span className="opacity-80">{t("nav.language")}</span>
      <select
        className="border rounded px-2 py-1"
        defaultValue={currentLocale}
        onChange={(e) => {
          const locale = e.target.value as (typeof locales)[number];
          startTransition(() => {
            const segments = pathname.split("/");
            // ['', 'en', '...']
            if (segments.length > 1) {
              segments[1] = locale;
            }
            const nextPath = segments.join("/") || `/${locale}`;
            const qs = searchParams.toString();
            router.replace(qs ? `${nextPath}?${qs}` : nextPath);
          });
        }}
        disabled={isPending}
        aria-label={t("nav.language")}
      >
        {locales.map((code) => (
          <option key={code} value={code}>
            {t(`lang.${code}`)}
          </option>
        ))}
      </select>
    </label>
  );
}
