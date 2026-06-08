"use client";

// Operator-facing event-leaf re-analysis backfill controls (#470 Scope §7).
//
// Replaces the "not yet available" placeholder on the re-analysis entry
// pages (admin + analyst). Drives the preview → required-confirm → launch →
// progress → cancel flow against the event-backfill API. Shared by both
// surfaces: the admin page passes `adminFetch` + the `/api/admin/...` base;
// the analyst page passes `apiFetch` + the `/api/customers/.../analysis/...`
// base. The cost preview shows counts/scope only — never a monetary figure.

import { useTranslations } from "next-intl";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";

interface PreviewCounts {
  totalUniverse: number;
  reanalyze: number;
  alreadyCurrent: number;
  sourceUnavailable: number;
  capExcluded: number;
}

interface TargetVariant {
  lang: string;
  modelName: string;
  model: string;
}

interface PreviewResponse {
  target: TargetVariant;
  windowDays: number;
  counts: PreviewCounts;
}

type RunStatus = "pending" | "running" | "completed" | "cancelled" | "failed";

interface BackfillRun {
  id: string;
  status: RunStatus;
  totalUniverse: number;
  reanalyzedCount: number;
  alreadyCurrentCount: number;
  sourceUnavailableCount: number;
  failedCount: number;
  capExcludedCount: number;
}

const ACTIVE: RunStatus[] = ["pending", "running"];
const WINDOW_DAYS = 7;
const POLL_MS = 3000;

export interface EventLeafBackfillPanelProps {
  /** Whether the customer id is known yet (gates fetching). */
  customerId: string | null;
  /** API base, e.g. `/api/admin/customers/{id}/event-backfill`. */
  apiBase: string;
  /** Context-appropriate fetch wrapper (adminFetch / apiFetch). */
  fetcher: <T>(url: string, options?: RequestInit) => Promise<T>;
}

export function EventLeafBackfillPanel({
  customerId,
  apiBase,
  fetcher,
}: EventLeafBackfillPanelProps) {
  const t = useTranslations("eventLeafBackfill");

  const [preview, setPreview] = useState<PreviewResponse | null>(null);
  const [previewError, setPreviewError] = useState(false);
  const [run, setRun] = useState<BackfillRun | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const loadPreview = useCallback(async () => {
    if (!customerId) return;
    try {
      const data = await fetcher<PreviewResponse>(
        `${apiBase}/preview?window_days=${WINDOW_DAYS}`,
      );
      setPreview(data);
      setPreviewError(false);
    } catch {
      setPreviewError(true);
    }
  }, [apiBase, customerId, fetcher]);

  const loadActiveRun = useCallback(async () => {
    if (!customerId) return;
    try {
      const data = await fetcher<{ runs: BackfillRun[] }>(apiBase);
      const active = data.runs.find((r) => ACTIVE.includes(r.status));
      setRun(active ?? data.runs[0] ?? null);
    } catch {
      // Non-fatal — the preview still renders.
    }
  }, [apiBase, customerId, fetcher]);

  useEffect(() => {
    void loadPreview();
    void loadActiveRun();
  }, [loadPreview, loadActiveRun]);

  // Poll the active run for progress until it reaches a terminal state.
  useEffect(() => {
    if (!run || !ACTIVE.includes(run.status)) {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
      return;
    }
    if (pollRef.current) return;
    pollRef.current = setInterval(async () => {
      try {
        const data = await fetcher<{ run: BackfillRun }>(
          `${apiBase}/runs/${run.id}`,
        );
        setRun(data.run);
      } catch {
        // Ignore transient poll failures.
      }
    }, POLL_MS);
    return () => {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
  }, [run, apiBase, fetcher]);

  const start = useCallback(async () => {
    if (!customerId) return;
    setSubmitting(true);
    setActionError(null);
    try {
      const data = await fetcher<{ run: BackfillRun }>(apiBase, {
        method: "POST",
        body: JSON.stringify({ windowDays: WINDOW_DAYS, confirm: true }),
      });
      setRun(data.run);
      setConfirming(false);
    } catch {
      setActionError(t("startError"));
    } finally {
      setSubmitting(false);
    }
  }, [apiBase, customerId, fetcher, t]);

  const cancel = useCallback(async () => {
    if (!run) return;
    setActionError(null);
    try {
      const data = await fetcher<{ run: BackfillRun }>(
        `${apiBase}/runs/${run.id}/cancel`,
        { method: "POST" },
      );
      setRun(data.run);
    } catch {
      setActionError(t("cancelError"));
    }
  }, [apiBase, run, fetcher, t]);

  const isActive = run != null && ACTIVE.includes(run.status);

  return (
    <section className="space-y-3 rounded-md border border-border bg-card p-4">
      <h2 className="text-base font-semibold text-foreground">
        {t("panelTitle")}
      </h2>
      <p className="text-sm text-muted-foreground">{t("panelDescription")}</p>

      {isActive && run ? (
        <div className="space-y-2">
          <p className="text-sm font-medium text-foreground">
            {t("runningTitle")}
          </p>
          <p className="text-sm text-muted-foreground">
            {t("runStatus", { status: t(`status_${run.status}`) })}
          </p>
          <p className="text-sm text-foreground">
            {t("runProgress", {
              done:
                run.reanalyzedCount +
                run.failedCount +
                run.alreadyCurrentCount +
                run.sourceUnavailableCount,
              total: run.totalUniverse,
            })}
          </p>
          <ul className="text-sm text-muted-foreground">
            <li>{t("runReanalyzed", { n: run.reanalyzedCount })}</li>
            <li>{t("runFailed", { n: run.failedCount })}</li>
            <li>
              {t("runSourceUnavailable", { n: run.sourceUnavailableCount })}
            </li>
            <li>{t("runCapExcluded", { n: run.capExcludedCount })}</li>
          </ul>
          <Button variant="destructive" onClick={cancel}>
            {t("cancelButton")}
          </Button>
        </div>
      ) : (
        <div className="space-y-2">
          {run && (
            <p className="text-sm text-muted-foreground">
              {t("lastRunStatus", { status: t(`status_${run.status}`) })}
            </p>
          )}
          {previewError ? (
            <p className="text-sm text-destructive">{t("previewError")}</p>
          ) : preview ? (
            <div className="space-y-2">
              <p className="text-sm font-medium text-foreground">
                {t("countsTitle", { days: preview.windowDays })}
              </p>
              <ul className="text-sm text-muted-foreground">
                <li>{t("countTotal", { n: preview.counts.totalUniverse })}</li>
                <li>{t("countReanalyze", { n: preview.counts.reanalyze })}</li>
                <li>
                  {t("countAlreadyCurrent", {
                    n: preview.counts.alreadyCurrent,
                  })}
                </li>
                <li>
                  {t("countSourceUnavailable", {
                    n: preview.counts.sourceUnavailable,
                  })}
                </li>
                <li>
                  {t("countCapExcluded", { n: preview.counts.capExcluded })}
                </li>
              </ul>
              <p className="text-xs text-muted-foreground">
                {t("noMonetaryNote")}
              </p>
              {preview.counts.reanalyze === 0 ? (
                <p className="text-sm text-muted-foreground">
                  {t("nothingToDo")}
                </p>
              ) : confirming ? (
                <div className="space-y-2 rounded-md border border-border p-3">
                  <p className="text-sm text-foreground">
                    {t("confirmBody", {
                      n: preview.counts.reanalyze,
                      model: `${preview.target.modelName} / ${preview.target.model}`,
                    })}
                  </p>
                  <div className="flex gap-2">
                    <Button onClick={start} disabled={submitting}>
                      {t("confirmProceed")}
                    </Button>
                    <Button
                      variant="ghost"
                      onClick={() => setConfirming(false)}
                      disabled={submitting}
                    >
                      {t("confirmDismiss")}
                    </Button>
                  </div>
                </div>
              ) : (
                <Button onClick={() => setConfirming(true)}>
                  {t("reanalyzeButton", { n: preview.counts.reanalyze })}
                </Button>
              )}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              {t("previewLoading")}
            </p>
          )}
          {actionError && (
            <p className="text-sm text-destructive">{actionError}</p>
          )}
        </div>
      )}
    </section>
  );
}
