"use client";

import { useTranslations } from "next-intl";
import { useCallback, useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { apiFetch } from "@/lib/api/client";

interface RetentionState {
  ingestionDays: number;
  analysisDays: number | null;
}

interface RetentionApiPayload {
  ingestion_days: number;
  analysis_days: number | null;
}

interface Props {
  customerId: string;
  canWrite: boolean;
}

function isShortening(prev: RetentionState, next: RetentionState): boolean {
  if (next.ingestionDays < prev.ingestionDays) return true;
  if (prev.analysisDays === null && next.analysisDays !== null) return true;
  if (
    prev.analysisDays !== null &&
    next.analysisDays !== null &&
    next.analysisDays < prev.analysisDays
  ) {
    return true;
  }
  return false;
}

export function RetentionSection({ customerId, canWrite }: Props) {
  const t = useTranslations("customerSettings");

  const [server, setServer] = useState<RetentionState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [ingestionInput, setIngestionInput] = useState("");
  const [analysisInput, setAnalysisInput] = useState("");
  const [unlimited, setUnlimited] = useState(false);

  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [confirmPrompt, setConfirmPrompt] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const data = await apiFetch<RetentionApiPayload>(
        `/api/admin/customers/${customerId}/retention`,
      );
      const state: RetentionState = {
        ingestionDays: data.ingestion_days,
        analysisDays: data.analysis_days,
      };
      setServer(state);
      setIngestionInput(String(state.ingestionDays));
      if (state.analysisDays === null) {
        setUnlimited(true);
        setAnalysisInput("");
      } else {
        setUnlimited(false);
        setAnalysisInput(String(state.analysisDays));
      }
      setError(null);
    } catch {
      setError(t("retentionLoadError"));
    } finally {
      setLoading(false);
    }
  }, [customerId, t]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const proposed = useCallback((): RetentionState | null => {
    const ingestion = Number.parseInt(ingestionInput, 10);
    if (!Number.isInteger(ingestion)) return null;
    if (unlimited) return { ingestionDays: ingestion, analysisDays: null };
    const analysis = Number.parseInt(analysisInput, 10);
    if (!Number.isInteger(analysis)) return null;
    return { ingestionDays: ingestion, analysisDays: analysis };
  }, [ingestionInput, analysisInput, unlimited]);

  const persist = useCallback(
    async (next: RetentionState) => {
      setSubmitting(true);
      setSubmitError(null);
      try {
        await apiFetch(`/api/admin/customers/${customerId}/retention`, {
          method: "PUT",
          body: JSON.stringify({
            ingestion_days: next.ingestionDays,
            analysis_days: next.analysisDays,
          }),
        });
        await reload();
      } catch (err) {
        const code = err instanceof Error ? err.message : "";
        setSubmitError(
          code === "retention_too_short"
            ? t("retentionTooShort")
            : t("retentionSaveGenericError"),
        );
      } finally {
        setSubmitting(false);
        setConfirmPrompt(null);
      }
    },
    [customerId, reload, t],
  );

  const handleSubmit = useCallback(
    async (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (!server) return;
      const next = proposed();
      if (!next) {
        setSubmitError(t("retentionParseError"));
        return;
      }
      if (isShortening(server, next)) {
        const unlimitedToFinite =
          server.analysisDays === null && next.analysisDays !== null;
        setConfirmPrompt(
          unlimitedToFinite
            ? t("retentionConfirmShortenUnlimited")
            : t("retentionConfirmShortenFinite"),
        );
        return;
      }
      await persist(next);
    },
    [server, proposed, persist, t],
  );

  const confirmShortenAndSave = useCallback(async () => {
    const next = proposed();
    if (!next) return;
    await persist(next);
  }, [proposed, persist]);

  return (
    <section className="space-y-4">
      <header>
        <h2 className="text-lg font-semibold text-foreground">
          {t("retentionTitle")}
        </h2>
        <p className="text-sm text-muted-foreground">
          {t("retentionDescription")}
        </p>
      </header>

      {loading && (
        <p className="text-sm text-muted-foreground">{t("loading")}</p>
      )}
      {error && <p className="text-sm text-destructive">{error}</p>}

      {!loading && server && (
        <form className="space-y-4" onSubmit={handleSubmit}>
          <div className="space-y-1">
            <label
              htmlFor="ingestion-days"
              className="text-sm font-medium text-foreground"
            >
              {t("ingestionDaysLabel")}
            </label>
            <Input
              id="ingestion-days"
              type="number"
              min={30}
              value={ingestionInput}
              onChange={(e) => setIngestionInput(e.target.value)}
              disabled={!canWrite || submitting}
              aria-label={t("ingestionDaysLabel")}
            />
          </div>

          <div className="space-y-1">
            <label
              htmlFor="analysis-days"
              className="text-sm font-medium text-foreground"
            >
              {t("analysisDaysLabel")}
            </label>
            <div className="flex items-center gap-3">
              <Input
                id="analysis-days"
                type="number"
                min={30}
                value={analysisInput}
                onChange={(e) => setAnalysisInput(e.target.value)}
                disabled={!canWrite || submitting || unlimited}
                aria-label={t("analysisDaysLabel")}
                className="flex-1"
              />
              <label className="flex items-center gap-2 text-sm text-foreground">
                <input
                  type="checkbox"
                  checked={unlimited}
                  onChange={(e) => setUnlimited(e.target.checked)}
                  disabled={!canWrite || submitting}
                  aria-label={t("analysisDaysUnlimitedLabel")}
                />
                {t("analysisDaysUnlimitedLabel")}
              </label>
            </div>
          </div>

          {submitError && (
            <p className="text-sm text-destructive">{submitError}</p>
          )}

          {canWrite && (
            <Button type="submit" disabled={submitting}>
              {t("save")}
            </Button>
          )}
        </form>
      )}

      {confirmPrompt && (
        <div
          role="alertdialog"
          aria-label={t("retentionShortenTitle")}
          className="rounded-md border border-border bg-card p-4 text-sm"
        >
          <p className="font-medium">{t("retentionShortenTitle")}</p>
          <p className="mt-1 text-foreground">{confirmPrompt}</p>
          <div className="mt-3 flex gap-2">
            <Button onClick={confirmShortenAndSave} disabled={submitting}>
              {t("retentionShortenConfirm")}
            </Button>
            <Button
              variant="ghost"
              onClick={() => setConfirmPrompt(null)}
              disabled={submitting}
            >
              {t("cancel")}
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}
