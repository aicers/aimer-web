"use client";

import { useParams } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { useCallback, useEffect, useState } from "react";

import { EventLeafBackfillPanel } from "@/components/analysis/event-leaf-backfill-panel";
import { ReanalyzeBackfillPanel } from "@/components/analysis/reanalyze-backfill-panel";
import { Button } from "@/components/ui/button";
import { Link } from "@/i18n/navigation";
import { adminFetch } from "@/lib/api/admin-client";
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
 * Admin, customer-scoped re-analysis entry point (#473 Scope 7).
 *
 * The admin-context counterpart of the dashboard re-analysis route
 * (`/settings/customer/reanalyze`). The post-change offer in the admin
 * per-customer default-model section deep-links HERE for the selected
 * customer, so a System Administrator — who may have no general customer
 * scope and therefore cannot reach the dashboard route — still gets a
 * stable launch surface after changing any customer's override. Like its
 * dashboard twin it hosts the #466 story-leaf backfill controls (cost
 * preview, scoping, confirm-gated enqueue, drain progress) via
 * `ReanalyzeBackfillPanel` and the #470 event-leaf backfill controls via
 * `EventLeafBackfillPanel`. Report refresh (#469) is sequenced after both
 * leaf runs drain and lands on this same surface as it ships.
 */
export default function AdminCustomerReanalyzePage() {
  const t = useTranslations("adminCustomerReanalyze");
  const locale = useLocale();
  const params = useParams<{ customerId: string }>();
  const customerId = params.customerId;

  const [effective, setEffective] = useState<ModelPair | null>(null);

  const load = useCallback(async () => {
    if (!customerId) return;
    try {
      const data = await adminFetch<DefaultModelView>(
        `/api/admin/customers/${customerId}/default-model`,
      );
      setEffective(data.effective);
    } catch {
      // Non-fatal: the page still explains the action without the model
      // chip if the lookup fails.
      setEffective(null);
    }
  }, [customerId]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="mx-auto max-w-4xl space-y-6 px-4 py-8 sm:px-6">
      <header className="space-y-2">
        <Link
          href="/admin/customers"
          className="text-sm text-muted-foreground underline"
        >
          {t("backToCustomers")}
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
        apiBase={`/api/admin/customers/${customerId}/reanalyze`}
        fetcher={adminFetch}
      />

      <EventLeafBackfillPanel
        customerId={customerId ?? null}
        apiBase={`/api/admin/customers/${customerId}/event-backfill`}
        fetcher={adminFetch}
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
