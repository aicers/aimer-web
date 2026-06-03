"use client";

import { useLocale, useTranslations } from "next-intl";
import { usePathname, useRouter } from "@/i18n/navigation";

function readCookie(name: string): string {
  const match = document.cookie
    .split("; ")
    .find((c) => c.startsWith(`${name}=`));
  return match ? match.split("=")[1] : "";
}

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
    //
    // The switcher is shared by the general and admin headers, and
    // /api/account/preferences authorizes either session, so send both
    // CSRF tokens when present — the route validates whichever context
    // it authorizes. This lets an admin-only session persist its choice
    // too, instead of silently 401-ing.
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    const csrf = readCookie("csrf");
    const adminCsrf = readCookie("csrf_admin");
    if (csrf) headers["X-CSRF-Token"] = csrf;
    if (adminCsrf) headers["X-CSRF-Token-Admin"] = adminCsrf;
    void fetch("/api/account/preferences", {
      method: "PATCH",
      headers,
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
