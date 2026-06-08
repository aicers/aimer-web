"use client";

import { useLocale, useTranslations } from "next-intl";
import { useCallback, useEffect, useState } from "react";

import { ReanalyzeBackfillPanel } from "@/components/analysis/reanalyze-backfill-panel";
import { Button } from "@/components/ui/button";
import { useCustomerContext } from "@/hooks/use-customer-context";
import { usePermissions } from "@/hooks/use-permissions";
import { Link } from "@/i18n/navigation";
import { apiFetch } from "@/lib/api/client";
import { manualUrl } from "@/lib/manual-url";

interface ModelPair {
  modelName: string;
  model: string;
}

interface DefaultModelView {
  effective: ModelPair;
  source: "customer" | "global" | "env";
}

/**
 * Customer-scoped re-analysis entry point (#473 Scope 7).
 *
 * The post-change offer in the customer settings default-model section
 * deep-links HERE (a stable in-app, customer-scoped route) rather than
 * straight to external docs. It now hosts the #466 story-leaf backfill
 * controls (cost preview, scoping, confirm-gated enqueue, drain progress)
 * via `ReanalyzeBackfillPanel`. Event-leaf re-analysis (#470) and report
 * refresh (#469) are sequenced after the story-leaf run drains and land on
 * this same surface as they ship.
 */
export default function CustomerReanalyzePage() {
  const t = useTranslations("customerReanalyze");
  const tCommon = useTranslations("common");
  const locale = useLocale();
  const { singleCustomerId } = useCustomerContext();
  const { canViewCustomerSettings } = usePermissions();

  const [effective, setEffective] = useState<ModelPair | null>(null);

  const load = useCallback(async () => {
    if (!singleCustomerId) return;
    try {
      const data = await apiFetch<DefaultModelView>(
        `/api/customers/${singleCustomerId}/analysis/default-model`,
      );
      setEffective(data.effective);
    } catch {
      // Non-fatal: the page still explains the action without the model
      // chip if the lookup fails.
      setEffective(null);
    }
  }, [singleCustomerId]);

  useEffect(() => {
    void load();
  }, [load]);

  // Customer Settings (and this entry point) render against a single
  // customer; under a multi-/all-scope there is no single target (#390).
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
    <div className="mx-auto max-w-4xl space-y-6 px-4 py-8 sm:px-6">
      <header className="space-y-2">
        <Link
          href="/settings/customer"
          className="text-sm text-muted-foreground underline"
        >
          {t("backToSettings")}
        </Link>
        <h1 className="text-2xl font-bold text-foreground">{t("title")}</h1>
        <p className="text-sm text-muted-foreground">{t("description")}</p>
      </header>

      {effective && (
        <p className="text-sm text-foreground">
          {t("targetModel", {
            model: `${effective.modelName} / ${effective.model}`,
          })}
        </p>
      )}

      <p className="text-sm text-muted-foreground">{t("guaranteeNote")}</p>

      <ReanalyzeBackfillPanel
        apiBase={`/api/customers/${singleCustomerId}/analysis/reanalyze`}
        fetcher={apiFetch}
      />

      <div>
        <Button asChild variant="ghost">
          <a
            href={`${manualUrl(
              "analysis/reanalyze-backfill",
              locale === "ko" ? "ko" : "en",
            )}`}
            target="_blank"
            rel="noreferrer"
          >
            {t("docsLink")}
          </a>
        </Button>
      </div>
    </div>
  );
}
