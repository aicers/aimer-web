"use client";

import { useParams } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { useCallback, useEffect, useState } from "react";

import { EventLeafBackfillPanel } from "@/components/analysis/event-leaf-backfill-panel";
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
 * dashboard twin this page is the ENTRY POINT only: it never enqueues
 * re-analysis. The actual cost preview, scoping, drain-gating and
 * throttling land with #466 (story leaves) / #470 (event leaves) → drain →
 * #469 (report refresh), which will replace the "not yet available" panel
 * with the real controls.
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

      <EventLeafBackfillPanel
        customerId={customerId ?? null}
        apiBase={`/api/admin/customers/${customerId}/event-backfill`}
        fetcher={adminFetch}
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
