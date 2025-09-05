import Link from "next/link";
import { getTranslations } from "next-intl/server";
// biome-ignore lint/correctness/noUnusedImports: needed for JSX
import React from "react";
import LanguageSwitcher from "@/components/language-switcher";
import { Button } from "@/components/ui/button";

interface Props {
  params: Promise<{ locale: string }>;
}

export default async function HomePage({ params }: Props) {
  const { locale } = await params;
  const t = await getTranslations();

  return (
    <main className="flex flex-col items-center justify-center min-h-screen gap-4 p-6">
      <div className="absolute top-4 right-4">
        <LanguageSwitcher />
      </div>
      <h1 className="text-3xl font-bold">{t("common.welcome")}</h1>
      <div className="flex gap-4">
        <Button asChild>
          <Link href={`/${locale}/signin?mode=user`}>
            {t("home.userSignIn")}
          </Link>
        </Button>
        <Button variant="outline" asChild>
          <Link href={`/${locale}/signin?mode=admin`}>
            {t("home.adminSignIn")}
          </Link>
        </Button>
      </div>
    </main>
  );
}
