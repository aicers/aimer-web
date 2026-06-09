"use client";

import { useTranslations } from "next-intl";
import { useCallback, useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { Link } from "@/i18n/navigation";
import { apiFetch } from "@/lib/api/client";
import { subjectApi } from "@/lib/navigation/routes";

interface ModelPair {
  modelName: string;
  model: string;
}

interface CatalogEntry extends ModelPair {
  label: string;
}

interface DefaultModelView {
  override: ModelPair | null;
  effective: ModelPair;
  source: "customer" | "global" | "env";
  envDefault: ModelPair;
  catalog: CatalogEntry[];
}

interface Props {
  customerId: string;
  canWrite: boolean;
}

// Encode a pair as a single <option> value (and back) as JSON. A textual
// (JSON) encoding keeps the source diffable — an earlier raw-delimiter form
// embedded a control byte that made git treat this file as binary
// (#473 review round 1).
const pairKey = (p: ModelPair): string =>
  JSON.stringify({ modelName: p.modelName, model: p.model });
const parsePairKey = (key: string): ModelPair => {
  const parsed = JSON.parse(key) as ModelPair;
  return { modelName: parsed.modelName, model: parsed.model };
};

export function DefaultModelSection({ customerId, canWrite }: Props) {
  const t = useTranslations("customerSettings");

  const [view, setView] = useState<DefaultModelView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [selected, setSelected] = useState<string>("");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  // The post-change re-analysis OFFER (#473 Scope 7): shown after a
  // successful model change. Entry point only — execution (the scoped
  // re-analysis / report refresh) is owned by #466/#470/#469 and is
  // never auto-run here.
  const [showReanalyzeOffer, setShowReanalyzeOffer] = useState(false);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const data = await apiFetch<DefaultModelView>(
        subjectApi.defaultModel(customerId),
      );
      setView(data);
      setSelected(pairKey(data.effective));
      setError(null);
    } catch {
      setError(t("defaultModelLoadError"));
    } finally {
      setLoading(false);
    }
  }, [customerId, t]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const sourceLabel = useCallback(
    (source: DefaultModelView["source"]): string => {
      if (source === "customer") return t("defaultModelSourceCustomer");
      if (source === "global") return t("defaultModelSourceGlobal");
      return t("defaultModelSourceEnv");
    },
    [t],
  );

  const handleSave = useCallback(
    async (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (!view) return;
      const pair = parsePairKey(selected);
      setSubmitting(true);
      setSubmitError(null);
      try {
        const res = await apiFetch<{ changed: boolean }>(
          subjectApi.defaultModel(customerId),
          { method: "PUT", body: JSON.stringify(pair) },
        );
        await reload();
        // Only surface the re-analysis offer when the default actually
        // changed (a no-op save leaves existing results untouched and
        // has nothing to offer re-analyzing).
        if (res.changed) setShowReanalyzeOffer(true);
      } catch (err) {
        const code = err instanceof Error ? err.message : "";
        setSubmitError(
          code === "model_not_in_catalog"
            ? t("defaultModelNotInCatalog")
            : t("defaultModelSaveGenericError"),
        );
      } finally {
        setSubmitting(false);
      }
    },
    [view, selected, customerId, reload, t],
  );

  const handleReset = useCallback(async () => {
    setSubmitting(true);
    setSubmitError(null);
    try {
      await apiFetch(subjectApi.defaultModel(customerId), {
        method: "DELETE",
      });
      await reload();
      setShowReanalyzeOffer(true);
    } catch {
      setSubmitError(t("defaultModelSaveGenericError"));
    } finally {
      setSubmitting(false);
    }
  }, [customerId, reload, t]);

  return (
    <section className="space-y-4">
      <header>
        <h2 className="text-lg font-semibold text-foreground">
          {t("defaultModelTitle")}
        </h2>
        <p className="text-sm text-muted-foreground">
          {t("defaultModelDescription")}
        </p>
      </header>

      {loading && (
        <p className="text-sm text-muted-foreground">{t("loading")}</p>
      )}
      {error && <p className="text-sm text-destructive">{error}</p>}

      {!loading && view && (
        <form className="space-y-4" onSubmit={handleSave}>
          <p className="text-sm text-foreground">
            {t("defaultModelCurrentSource", {
              model: `${view.effective.modelName} / ${view.effective.model}`,
              source: sourceLabel(view.source),
            })}
          </p>

          <div className="space-y-1">
            <label
              htmlFor="default-model-select"
              className="text-sm font-medium text-foreground"
            >
              {t("defaultModelLabel")}
            </label>
            <Select
              id="default-model-select"
              value={selected}
              onChange={(e) => setSelected(e.target.value)}
              disabled={!canWrite || submitting}
              aria-label={t("defaultModelLabel")}
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

          {canWrite && (
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
                  {t("defaultModelResetToGlobal")}
                </Button>
              )}
            </div>
          )}
        </form>
      )}

      {showReanalyzeOffer && (
        <div
          role="status"
          aria-label={t("defaultModelReanalyzeOfferTitle")}
          className="rounded-md border border-border bg-card p-4 text-sm"
        >
          <p className="font-medium">{t("defaultModelReanalyzeOfferTitle")}</p>
          <p className="mt-1 text-foreground">
            {t("defaultModelReanalyzeOfferBody")}
          </p>
          <div className="mt-3 flex gap-2">
            {/*
              Launch entry point (#473 Scope 7). Deep-links to the stable
              in-app, customer-scoped re-analysis route, which the scoped,
              cost-bounded re-analysis owned by #466/#470/#469 will own and
              fill with the real controls. This action only NAVIGATES — it
              never enqueues anything, so the model-change action still never
              auto-runs re-analysis.
            */}
            <Button asChild>
              <Link href="/settings/customer/reanalyze">
                {t("defaultModelReanalyzeOfferLaunch")}
              </Link>
            </Button>
            <Button
              variant="ghost"
              onClick={() => setShowReanalyzeOffer(false)}
            >
              {t("defaultModelReanalyzeOfferDismiss")}
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}
