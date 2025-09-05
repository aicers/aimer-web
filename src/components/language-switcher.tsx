"use client";

import { usePathname, useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
// biome-ignore lint/correctness/noUnusedImports: needed for JSX
import React from "react";
import { Button } from "@/components/ui/button";

export default function LanguageSwitcher() {
  const t = useTranslations();
  const locale = useLocale();
  const router = useRouter();
  const pathname = usePathname();

  const switchLanguage = () => {
    const newLocale = locale === "en" ? "ko" : "en";
    // Replace the locale in the current path
    const newPath = pathname.replace(`/${locale}`, `/${newLocale}`);
    router.push(newPath);
  };

  return (
    <Button variant="outline" size="sm" onClick={switchLanguage}>
      {locale === "en" ? t("language.korean") : t("language.english")}
    </Button>
  );
}
