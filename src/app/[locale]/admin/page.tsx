import { getTranslations } from "next-intl/server";
// biome-ignore lint/correctness/noUnusedImports: needed for JSX
import React from "react";
import LanguageSwitcher from "@/components/language-switcher";

export default async function AdminAppPage() {
  const t = await getTranslations();

  return (
    <main className="p-6">
      <div className="absolute top-4 right-4">
        <LanguageSwitcher />
      </div>
      <h1 className="text-2xl font-bold">{t("admin.title")}</h1>
      <p>{t("admin.welcome")}</p>
    </main>
  );
}
