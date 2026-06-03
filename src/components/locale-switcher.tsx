"use client";

import { useLocale, useTranslations } from "next-intl";
import { usePathname, useRouter } from "@/i18n/navigation";
import { apiFetch } from "@/lib/api/client";

export function LocaleSwitcher() {
  const locale = useLocale();
  const router = useRouter();
  const pathname = usePathname();
  const t = useTranslations("common");

  function onChange(newLocale: string) {
    // biome-ignore lint/suspicious/noDocumentCookie: next-intl requires cookie for locale persistence
    document.cookie = `NEXT_LOCALE=${newLocale};path=/;max-age=31536000`;
    localStorage.setItem("locale", newLocale);
    // Persist to the signed-in account so the choice follows the user
    // across devices and stays in sync with the NEXT_LOCALE cookie
    // (#387). Best-effort: ignored when not signed in.
    void apiFetch("/api/account/preferences", {
      method: "PATCH",
      body: JSON.stringify({ locale: newLocale }),
    }).catch(() => {});
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
