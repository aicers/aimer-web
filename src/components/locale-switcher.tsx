"use client";

import { useLocale, useTranslations } from "next-intl";
import { usePathname, useRouter } from "@/i18n/navigation";

export function LocaleSwitcher() {
  const locale = useLocale();
  const router = useRouter();
  const pathname = usePathname();
  const t = useTranslations("common");

  function onChange(newLocale: string) {
    // biome-ignore lint/suspicious/noDocumentCookie: next-intl requires cookie for locale persistence
    document.cookie = `NEXT_LOCALE=${newLocale};path=/;max-age=31536000`;
    localStorage.setItem("locale", newLocale);
    router.replace(pathname, { locale: newLocale });
  }

  return (
    <button
      type="button"
      onClick={() => onChange(locale === "ko" ? "en" : "ko")}
      className="text-sm"
    >
      {locale === "ko" ? t("switchToEnglish") : t("switchToKorean")}
    </button>
  );
}
