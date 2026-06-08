"use client";

import { useTranslations } from "next-intl";

import { useCustomerContext } from "@/hooks/use-customer-context";
import { usePermissions } from "@/hooks/use-permissions";

import { DefaultModelSection } from "./default-model-section";
import { RedactionRangesSection } from "./redaction-ranges-section";
import { RetentionSection } from "./retention-section";

export default function CustomerSettingsPage() {
  const t = useTranslations("nav");
  const tCommon = useTranslations("common");
  const { singleCustomerId } = useCustomerContext();
  const {
    canViewCustomerSettings,
    canViewRedactionRanges,
    canWriteRedactionRanges,
    canViewRetention,
    canWriteRetention,
    canViewDefaultModel,
    canWriteDefaultModel,
  } = usePermissions();

  // Customer Settings renders against a single customer. Under a multi-/
  // all-scope there is no single target — show a scope-required state
  // rather than a permission error (#390).
  if (!singleCustomerId) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-sm text-muted-foreground">
          {tCommon("scopeRequired")}
        </p>
      </div>
    );
  }

  if (!canViewCustomerSettings) {
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
          customerId={singleCustomerId}
          canWrite={canWriteRedactionRanges}
        />
      )}

      {canViewRetention && (
        <RetentionSection
          customerId={singleCustomerId}
          canWrite={canWriteRetention}
        />
      )}

      {canViewDefaultModel && (
        <DefaultModelSection
          customerId={singleCustomerId}
          canWrite={canWriteDefaultModel}
        />
      )}
    </div>
  );
}
