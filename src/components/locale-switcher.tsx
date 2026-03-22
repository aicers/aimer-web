"use client";

import { useLocale } from "next-intl";
import { useRouter, usePathname } from "@/i18n/navigation";

export function LocaleSwitcher() {
  const locale = useLocale();
  const router = useRouter();
  const pathname = usePathname();

  function onChange(newLocale: string) {
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
      {locale === "ko" ? "English" : "한국어"}
    </button>
  );
}
