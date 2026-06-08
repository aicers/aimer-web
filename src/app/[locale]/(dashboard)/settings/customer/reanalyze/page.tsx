"use client";

import { useLocale, useTranslations } from "next-intl";
import { useCallback, useEffect, useState } from "react";

import { EventLeafBackfillPanel } from "@/components/analysis/event-leaf-backfill-panel";
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
 * straight to external docs, so the scoped re-analysis owned by
 * #466 (story leaves) / #470 (event leaves) → drain → #469 (report
 * refresh) has a stable launch surface to own. This page is the ENTRY
 * POINT only: it never enqueues re-analysis. The actual cost preview,
 * scoping, drain-gating and throttling land with those issues, which will
 * replace the "not yet available" panel below with the real controls.
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

      <EventLeafBackfillPanel
        customerId={singleCustomerId}
        apiBase={`/api/customers/${singleCustomerId}/analysis/event-backfill`}
        fetcher={apiFetch}
      />

      <section className="space-y-2 rounded-md border border-border bg-card p-4">
        <p className="text-sm text-foreground">{t("guaranteeNote")}</p>
        <div className="pt-2">
          <Button asChild variant="ghost">
            <a
              href={`${manualUrl(
                "analysis/default-model",
                locale === "ko" ? "ko" : "en",
              )}#what-a-change-affects`}
              target="_blank"
              rel="noreferrer"
            >
              {t("docsLink")}
            </a>
          </Button>
        </div>
      </section>
    </div>
  );
}
