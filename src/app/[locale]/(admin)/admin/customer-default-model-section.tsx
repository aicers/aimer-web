"use client";

import { useTranslations } from "next-intl";
import { useCallback, useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
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
        await adminFetch(`/api/admin/customers/${customerId}/default-model`, {
          method: "PUT",
          body: JSON.stringify(pair),
        });
        await reload(customerId);
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
    </section>
  );
}
