"use client";

import { useTranslations } from "next-intl";

import { useCustomerContext } from "@/hooks/use-customer-context";
import { usePermissions } from "@/hooks/use-permissions";

import { RedactionRangesSection } from "./redaction-ranges-section";
import { RetentionSection } from "./retention-section";

export default function CustomerSettingsPage() {
  const t = useTranslations("nav");
  const tCommon = useTranslations("common");
  const { selectedCustomerId } = useCustomerContext();
  const {
    canViewCustomerSettings,
    canViewRedactionRanges,
    canWriteRedactionRanges,
    canViewRetention,
    canWriteRetention,
  } = usePermissions();

  if (!canViewCustomerSettings || !selectedCustomerId) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-sm text-destructive">{tCommon("forbidden")}</p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-4xl space-y-10 px-4 py-8 sm:px-6">
      <h1 className="text-2xl font-bold text-foreground">
        {t("customerSettings")}
      </h1>

      {canViewRedactionRanges && (
        <RedactionRangesSection
          customerId={selectedCustomerId}
          canWrite={canWriteRedactionRanges}
        />
      )}

      {canViewRetention && (
        <RetentionSection
          customerId={selectedCustomerId}
          canWrite={canWriteRetention}
        />
      )}
    </div>
  );
}
