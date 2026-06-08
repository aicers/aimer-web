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

interface GlobalDefaultView {
  global: ModelPair | null;
  // Whether `global` is currently catalog-active (i.e. the resolver/workers
  // would actually use it). A stored-but-inactive value is stale.
  globalActive: boolean;
  // The default the resolver would actually pick at the global tier:
  // `global` when active, else the env fallback.
  effective: ModelPair;
  source: "global" | "env";
  envDefault: ModelPair;
  catalog: CatalogEntry[];
}

const pairKey = (p: ModelPair): string => `${p.modelName} ${p.model}`;
const parsePairKey = (key: string): ModelPair => {
  const [modelName, model] = key.split(" ");
  return { modelName, model };
};

/**
 * Admin-set global default analysis model (#473) — the second tier of the
 * three-tier resolution order (per-customer → global → env). System
 * Administrator only. Clearing reverts global resolution to the env
 * fallback.
 */
export function AnalysisDefaultModelSection() {
  const t = useTranslations("adminAnalysisModel");

  const [view, setView] = useState<GlobalDefaultView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [selected, setSelected] = useState<string>("");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const data = await adminFetch<GlobalDefaultView>(
        "/api/admin/analysis-default-model",
      );
      setView(data);
      // Seed the picker from the EFFECTIVE default (always catalog-valid),
      // not the raw stored value — a stale out-of-catalog `global` has no
      // matching <option> and would leave the select unselectable.
      setSelected(pairKey(data.effective));
      setError(null);
    } catch {
      setError(t("loadError"));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const handleSave = useCallback(
    async (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const pair = parsePairKey(selected);
      setSubmitting(true);
      setSubmitError(null);
      try {
        await adminFetch("/api/admin/analysis-default-model", {
          method: "PUT",
          body: JSON.stringify(pair),
        });
        await reload();
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
    [selected, reload, t],
  );

  const handleClear = useCallback(async () => {
    setSubmitting(true);
    setSubmitError(null);
    try {
      await adminFetch("/api/admin/analysis-default-model", {
        method: "DELETE",
      });
      await reload();
    } catch {
      setSubmitError(t("saveGenericError"));
    } finally {
      setSubmitting(false);
    }
  }, [reload, t]);

  return (
    <section className="space-y-4 rounded-md border border-border bg-card p-6">
      <header>
        <h2 className="text-lg font-semibold text-foreground">{t("title")}</h2>
        <p className="text-sm text-muted-foreground">{t("description")}</p>
      </header>

      {loading && (
        <p className="text-sm text-muted-foreground">{t("loading")}</p>
      )}
      {error && <p className="text-sm text-destructive">{error}</p>}

      {!loading && view && (
        <form className="space-y-4" onSubmit={handleSave}>
          {view.global && !view.globalActive ? (
            // Stale: a global default is stored but is no longer in the
            // catalog, so the resolver ignores it and falls through to env.
            // Surface that explicitly instead of advertising it as live.
            <p className="text-sm text-destructive">
              {t("currentStale", {
                stored: `${view.global.modelName} / ${view.global.model}`,
                effective: `${view.effective.modelName} / ${view.effective.model}`,
              })}
            </p>
          ) : (
            <p className="text-sm text-foreground">
              {view.global
                ? t("currentGlobal", {
                    model: `${view.global.modelName} / ${view.global.model}`,
                  })
                : t("currentEnv", {
                    model: `${view.envDefault.modelName} / ${view.envDefault.model}`,
                  })}
            </p>
          )}

          <div className="space-y-1">
            <label
              htmlFor="admin-default-model-select"
              className="text-sm font-medium text-foreground"
            >
              {t("label")}
            </label>
            <Select
              id="admin-default-model-select"
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
            {view.global !== null && (
              <Button
                type="button"
                variant="ghost"
                onClick={handleClear}
                disabled={submitting}
              >
                {t("clear")}
              </Button>
            )}
          </div>
        </form>
      )}
    </section>
  );
}
