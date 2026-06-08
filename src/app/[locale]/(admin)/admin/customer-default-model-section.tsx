"use client";

import { useTranslations } from "next-intl";
import { useCallback, useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { Link } from "@/i18n/navigation";
import { adminFetch } from "@/lib/api/admin-client";

interface ModelPair {
  modelName: string;
  model: string;
}

interface CatalogEntry extends ModelPair {
  label: string;
}

interface CustomerDefaultModelView {
  override: ModelPair | null;
  effective: ModelPair;
  source: "customer" | "global" | "env";
  envDefault: ModelPair;
  catalog: CatalogEntry[];
}

interface Customer {
  id: string;
  name: string;
}

const pairKey = (p: ModelPair): string =>
  JSON.stringify({ modelName: p.modelName, model: p.model });
const parsePairKey = (key: string): ModelPair => {
  const parsed = JSON.parse(key) as ModelPair;
  return { modelName: parsed.modelName, model: parsed.model };
};

/**
 * Admin per-customer default analysis model (#473). System Administrator
 * only, any customer — the admin-context counterpart of the Analyst-facing
 * Customer Settings control. Both drive the SAME service/guard; this
 * surface exists so an administrator without general customer scope can
 * still set a customer's override in-app, not only via the API. The
 * per-customer override is the first tier of the three-tier resolution
 * order (per-customer → global → env); clearing it reverts the customer to
 * the global default.
 */
export function CustomerDefaultModelSection() {
  const t = useTranslations("adminCustomerDefaultModel");

  const [customers, setCustomers] = useState<Customer[]>([]);
  const [customersError, setCustomersError] = useState<string | null>(null);
  const [customerId, setCustomerId] = useState<string>("");

  const [view, setView] = useState<CustomerDefaultModelView | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [selected, setSelected] = useState<string>("");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  // The post-change re-analysis OFFER (#473 Scope 7). The issue allows a
  // System Administrator to change ANY customer's per-customer override, so
  // the "after a successful per-customer model change, surface the
  // follow-on prompt" requirement applies to this admin surface too — not
  // only the Analyst-facing Customer Settings control. Entry point only:
  // execution (the scoped re-analysis / report refresh) is owned by
  // #466/#470/#469 and is never auto-run here.
  const [showReanalyzeOffer, setShowReanalyzeOffer] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        const data = await adminFetch<{ customers: Customer[] }>(
          "/api/admin/customers",
        );
        setCustomers(data.customers);
        setCustomersError(null);
      } catch {
        setCustomersError(t("customersLoadError"));
      }
    })();
  }, [t]);

  const reload = useCallback(
    async (id: string) => {
      // Switching customers (or reloading) drops any stale offer; a save
      // or reset re-raises it after this resolves.
      setShowReanalyzeOffer(false);
      if (!id) {
        setView(null);
        return;
      }
      setLoading(true);
      try {
        const data = await adminFetch<CustomerDefaultModelView>(
          `/api/admin/customers/${id}/default-model`,
        );
        setView(data);
        setSelected(pairKey(data.effective));
        setError(null);
      } catch {
        setError(t("loadError"));
        setView(null);
      } finally {
        setLoading(false);
      }
    },
    [t],
  );

  useEffect(() => {
    void reload(customerId);
  }, [customerId, reload]);

  const sourceLabel = useCallback(
    (source: CustomerDefaultModelView["source"]): string => {
      if (source === "customer") return t("sourceCustomer");
      if (source === "global") return t("sourceGlobal");
      return t("sourceEnv");
    },
    [t],
  );

  const handleSave = useCallback(
    async (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (!view || !customerId) return;
      const pair = parsePairKey(selected);
      setSubmitting(true);
      setSubmitError(null);
      try {
        const res = await adminFetch<{ changed: boolean }>(
          `/api/admin/customers/${customerId}/default-model`,
          { method: "PUT", body: JSON.stringify(pair) },
        );
        await reload(customerId);
        // Only offer re-analysis when the default actually changed (a no-op
        // save leaves existing results untouched and has nothing to offer).
        if (res.changed) setShowReanalyzeOffer(true);
      } catch (err) {
        const code = err instanceof Error ? err.message : "";
        setSubmitError(
          code === "model_not_in_catalog"
            ? t("notInCatalog")
            : t("saveGenericError"),
        );
      } finally {
        setSubmitting(false);
      }
    },
    [view, customerId, selected, reload, t],
  );

  const handleReset = useCallback(async () => {
    if (!customerId) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      await adminFetch(`/api/admin/customers/${customerId}/default-model`, {
        method: "DELETE",
      });
      await reload(customerId);
      // The reset button only renders when an override exists, so clearing
      // it reverts the customer to the global default — a change worth
      // offering to re-analyze under.
      setShowReanalyzeOffer(true);
    } catch {
      setSubmitError(t("saveGenericError"));
    } finally {
      setSubmitting(false);
    }
  }, [customerId, reload, t]);

  return (
    <section className="space-y-4 rounded-md border border-border bg-card p-6">
      <header>
        <h2 className="text-lg font-semibold text-foreground">{t("title")}</h2>
        <p className="text-sm text-muted-foreground">{t("description")}</p>
      </header>

      {customersError && (
        <p className="text-sm text-destructive">{customersError}</p>
      )}

      <div className="space-y-1">
        <label
          htmlFor="admin-customer-default-model-customer"
          className="text-sm font-medium text-foreground"
        >
          {t("customerLabel")}
        </label>
        <Select
          id="admin-customer-default-model-customer"
          value={customerId}
          onChange={(e) => setCustomerId(e.target.value)}
          aria-label={t("customerLabel")}
        >
          <option value="">{t("customerPlaceholder")}</option>
          {customers.map((customer) => (
            <option key={customer.id} value={customer.id}>
              {customer.name}
            </option>
          ))}
        </Select>
      </div>

      {loading && (
        <p className="text-sm text-muted-foreground">{t("loading")}</p>
      )}
      {error && <p className="text-sm text-destructive">{error}</p>}

      {!loading && view && customerId && (
        <form className="space-y-4" onSubmit={handleSave}>
          <p className="text-sm text-foreground">
            {t("currentSource", {
              model: `${view.effective.modelName} / ${view.effective.model}`,
              source: sourceLabel(view.source),
            })}
          </p>

          <div className="space-y-1">
            <label
              htmlFor="admin-customer-default-model-select"
              className="text-sm font-medium text-foreground"
            >
              {t("label")}
            </label>
            <Select
              id="admin-customer-default-model-select"
              value={selected}
              onChange={(e) => setSelected(e.target.value)}
              disabled={submitting}
              aria-label={t("label")}
            >
              {view.catalog.map((entry) => (
                <option key={pairKey(entry)} value={pairKey(entry)}>
                  {entry.label}
                </option>
              ))}
            </Select>
          </div>

          {submitError && (
            <p className="text-sm text-destructive">{submitError}</p>
          )}

          <div className="flex gap-2">
            <Button type="submit" disabled={submitting}>
              {t("save")}
            </Button>
            {view.override !== null && (
              <Button
                type="button"
                variant="ghost"
                onClick={handleReset}
                disabled={submitting}
              >
                {t("resetToGlobal")}
              </Button>
            )}
          </div>
        </form>
      )}

      {showReanalyzeOffer && customerId && (
        <div
          role="status"
          aria-label={t("reanalyzeOfferTitle")}
          className="rounded-md border border-border bg-background p-4 text-sm"
        >
          <p className="font-medium">{t("reanalyzeOfferTitle")}</p>
          <p className="mt-1 text-foreground">{t("reanalyzeOfferBody")}</p>
          <div className="mt-3 flex gap-2">
            {/*
              Launch entry point (#473 Scope 7). Deep-links to the admin,
              customer-scoped re-analysis route for the SELECTED customer —
              the admin-context counterpart of the dashboard re-analysis
              route, so a System Administrator without general customer
              scope still reaches it. This action only NAVIGATES — it never
              enqueues anything, so the model-change action still never
              auto-runs re-analysis.
            */}
            <Button asChild>
              <Link href={`/admin/customers/${customerId}/reanalyze`}>
                {t("reanalyzeOfferLaunch")}
              </Link>
            </Button>
            <Button
              variant="ghost"
              onClick={() => setShowReanalyzeOffer(false)}
            >
              {t("reanalyzeOfferDismiss")}
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}
