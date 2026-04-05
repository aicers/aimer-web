"use client";

import { useTranslations } from "next-intl";

import { usePermissions } from "@/hooks/use-permissions";

export default function CustomerSettingsPage() {
  const t = useTranslations("nav");
  const tCommon = useTranslations("common");
  const { canViewCustomerSettings } = usePermissions();

  if (!canViewCustomerSettings) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-sm text-destructive">{tCommon("forbidden")}</p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-4xl px-4 py-8 sm:px-6">
      <h1 className="text-2xl font-bold text-foreground">
        {t("customerSettings")}
      </h1>
      <p className="mt-1 text-sm text-muted-foreground">
        {tCommon("comingSoon")}
      </p>
    </div>
  );
}
