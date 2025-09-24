"use client";

import { useSearchParams } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { useTransition } from "react";
import { locales, usePathname, useRouter } from "@/i18n/navigation";

export function LanguageSwitcher() {
  const t = useTranslations();
  const locale = useLocale();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [isPending, startTransition] = useTransition();

  return (
    <label className="text-sm flex items-center gap-2">
      <span className="opacity-80">{t("nav.language")}</span>
      <select
        className="border rounded px-2 py-1"
        value={locale}
        onChange={(e) => {
          const locale = e.target.value as (typeof locales)[number];
          startTransition(() => {
            const qs = searchParams.toString();
            const href = pathname && pathname.length > 0 ? pathname : "/";
            router.replace(qs ? `${href}?${qs}` : href, { locale });
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
