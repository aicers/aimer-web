"use client";

import { useTranslations } from "next-intl";
import { useCallback, useEffect, useState } from "react";

import { Button } from "@/components/ui/button";

/**
 * Operator-facing story-leaf re-analysis backfill controls (#466).
 *
 * Renders the cost preview (target scope + per-category counts), the
 * required explicit confirmation, the enqueue action, and the
 * scope-addressable drain-completion progress. Story leaves ONLY — report
 * refresh (#469) and event leaves (#470) are separate, sequenced surfaces.
 *
 * Reusable across the admin and dashboard re-analysis pages: the caller
 * supplies the API base path and the matching fetch helper (admin vs
 * general context), so one component drives both surfaces. The component
 * never picks the target model — the server resolves the customer's current
 * effective default and the preview/confirm reflect it.
 */

interface EnqueueCounts {
  seeded: number;
  requeued: number;
  coalesced: number;
  skipped_dirty: number;
  source_unavailable: number;
  cap_excluded: number;
}

interface PreviewResponse {
  scope: {
    modelName: string;
    model: string;
    windowDays: number | null;
    cap: number | null;
  };
  counts: EnqueueCounts;
}

interface DrainSignal {
  totalLeaves: number;
  outstanding: number;
  drained: boolean;
  counts: {
    drained: number;
    absent: number;
    queued: number;
    processing: number;
    failed_outstanding: number;
    skipped_dirty: number;
    source_unavailable: number;
  };
}

type Fetcher = <T>(url: string, init?: RequestInit) => Promise<T>;

interface Props {
  /** API base, e.g. `/api/admin/customers/{id}/reanalyze`. */
  apiBase: string;
  /** Context-appropriate fetch helper (admin vs general). */
  fetcher: Fetcher;
}

export function ReanalyzeBackfillPanel({ apiBase, fetcher }: Props) {
  const t = useTranslations("reanalyzeBackfill");

  // Scope controls. The default is the conservative 7-day recent window
  // (#466 Scope §3); "all history" is opt-in. The per-run cap is optional.
  const [allHistory, setAllHistory] = useState(false);
  const [windowDays, setWindowDays] = useState("7");
  const [cap, setCap] = useState("");

  const [preview, setPreview] = useState<PreviewResponse | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);

  const [confirmed, setConfirmed] = useState(false);
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const [runResult, setRunResult] = useState<EnqueueCounts | null>(null);

  const [status, setStatus] = useState<DrainSignal | null>(null);
  const [statusLoading, setStatusLoading] = useState(false);

  const scopeQuery = useCallback(() => {
    const params = new URLSearchParams();
    params.set("windowDays", allHistory ? "all" : windowDays);
    if (cap.trim() !== "") params.set("cap", cap.trim());
    return params.toString();
  }, [allHistory, windowDays, cap]);

  // Any scope edit invalidates the prior preview, its confirmation, and the
  // last run summary: the shown counts no longer match the edited scope, so
  // the operator must re-preview and re-acknowledge before Start re-appears.
  // Without this, a user could confirm the 7-day counts then widen to "all
  // history" and Start an unpreviewed, larger run (#466 Scope §7).
  const invalidatePreview = useCallback(() => {
    setPreview(null);
    setConfirmed(false);
    setRunResult(null);
    setPreviewError(null);
  }, []);

  const loadPreview = useCallback(async () => {
    setPreviewing(true);
    setPreviewError(null);
    // A fresh preview invalidates a prior confirmation and run summary —
    // the operator must re-acknowledge the new scope's counts.
    setConfirmed(false);
    setRunResult(null);
    try {
      const data = await fetcher<PreviewResponse>(
        `${apiBase}/preview?${scopeQuery()}`,
      );
      setPreview(data);
    } catch {
      setPreview(null);
      setPreviewError(t("previewError"));
    } finally {
      setPreviewing(false);
    }
  }, [apiBase, fetcher, scopeQuery, t]);

  // Show the default-scope preview on mount so the cost is visible upfront.
  // Mount-only: later scope edits re-preview via the explicit button, not on
  // every keystroke.
  // biome-ignore lint/correctness/useExhaustiveDependencies: mount-only initial preview
  useEffect(() => {
    void loadPreview();
  }, []);

  const loadStatus = useCallback(async () => {
    setStatusLoading(true);
    try {
      const data = await fetcher<DrainSignal>(
        `${apiBase}/status?${scopeQuery()}`,
      );
      setStatus(data);
    } catch {
      setStatus(null);
    } finally {
      setStatusLoading(false);
    }
  }, [apiBase, fetcher, scopeQuery]);

  const handleRun = useCallback(async () => {
    // POST the EXACT scope that was previewed and confirmed — never the live
    // form values — so a scope edit slipping past `invalidatePreview` can
    // never turn the confirmed run into a different one.
    if (!preview) return;
    setRunning(true);
    setRunError(null);
    try {
      const body = {
        confirm: true,
        windowDays:
          preview.scope.windowDays === null ? "all" : preview.scope.windowDays,
        cap: preview.scope.cap,
      };
      const data = await fetcher<{ counts: EnqueueCounts }>(apiBase, {
        method: "POST",
        body: JSON.stringify(body),
      });
      setRunResult(data.counts);
      await loadStatus();
    } catch {
      setRunError(t("runError"));
    } finally {
      setRunning(false);
    }
  }, [apiBase, fetcher, preview, loadStatus, t]);

  const counts = preview?.counts;
  const toEnqueue = counts ? counts.seeded + counts.requeued : 0;

  return (
    <section className="space-y-6 rounded-md border border-border bg-card p-4">
      <div className="space-y-1">
        <h2 className="text-base font-semibold text-foreground">
          {t("title")}
        </h2>
        <p className="text-sm text-muted-foreground">{t("description")}</p>
      </div>

      {/* Scope controls */}
      <div className="space-y-3">
        <div className="flex flex-wrap items-end gap-4">
          <div className="space-y-1">
            <label
              htmlFor="reanalyze-window-days"
              className="text-sm font-medium text-foreground"
            >
              {t("windowDaysLabel")}
            </label>
            <input
              id="reanalyze-window-days"
              type="number"
              min={1}
              value={windowDays}
              disabled={allHistory || previewing}
              onChange={(e) => {
                setWindowDays(e.target.value);
                invalidatePreview();
              }}
              className="w-28 rounded-md border border-border bg-background px-2 py-1 text-sm"
            />
          </div>
          <label className="flex items-center gap-2 text-sm text-foreground">
            <input
              type="checkbox"
              checked={allHistory}
              disabled={previewing}
              onChange={(e) => {
                setAllHistory(e.target.checked);
                invalidatePreview();
              }}
            />
            {t("allHistoryLabel")}
          </label>
          <div className="space-y-1">
            <label
              htmlFor="reanalyze-cap"
              className="text-sm font-medium text-foreground"
            >
              {t("capLabel")}
            </label>
            <input
              id="reanalyze-cap"
              type="number"
              min={1}
              value={cap}
              placeholder={t("capPlaceholder")}
              disabled={previewing}
              onChange={(e) => {
                setCap(e.target.value);
                invalidatePreview();
              }}
              className="w-28 rounded-md border border-border bg-background px-2 py-1 text-sm"
            />
          </div>
          <Button
            type="button"
            onClick={() => void loadPreview()}
            disabled={previewing}
          >
            {previewing ? t("previewing") : t("previewButton")}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">{t("scopeHint")}</p>
      </div>

      {previewError && (
        <p className="text-sm text-destructive">{previewError}</p>
      )}

      {/* Cost preview */}
      {counts && preview && (
        <div className="space-y-2 rounded-md border border-border bg-background p-4">
          <p className="text-sm font-medium text-foreground">
            {t("previewTitle", {
              model: `${preview.scope.modelName} / ${preview.scope.model}`,
            })}
          </p>
          <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm">
            <dt className="text-foreground">{t("toEnqueue")}</dt>
            <dd className="text-right font-medium text-foreground">
              {toEnqueue}
            </dd>
            <dt className="text-muted-foreground">{t("coalesced")}</dt>
            <dd className="text-right text-muted-foreground">
              {counts.coalesced}
            </dd>
            <dt className="text-muted-foreground">{t("skippedDirty")}</dt>
            <dd className="text-right text-muted-foreground">
              {counts.skipped_dirty}
            </dd>
            <dt className="text-muted-foreground">{t("sourceUnavailable")}</dt>
            <dd className="text-right text-muted-foreground">
              {counts.source_unavailable}
            </dd>
            <dt className="text-muted-foreground">{t("capExcluded")}</dt>
            <dd className="text-right text-muted-foreground">
              {counts.cap_excluded}
            </dd>
          </dl>
          {counts.cap_excluded > 0 && (
            <p className="text-xs text-muted-foreground">
              {t("capExcludedNote", { count: counts.cap_excluded })}
            </p>
          )}
        </div>
      )}

      {/* Required explicit confirmation (#466 Scope §7) */}
      {counts && (
        <div className="space-y-3">
          <label className="flex items-start gap-2 text-sm text-foreground">
            <input
              type="checkbox"
              checked={confirmed}
              disabled={running || toEnqueue === 0}
              onChange={(e) => setConfirmed(e.target.checked)}
              className="mt-1"
            />
            <span>{t("confirmLabel", { count: toEnqueue })}</span>
          </label>
          {runError && <p className="text-sm text-destructive">{runError}</p>}
          <Button
            type="button"
            onClick={() => void handleRun()}
            disabled={!confirmed || running || toEnqueue === 0}
          >
            {running ? t("starting") : t("startButton")}
          </Button>
          {toEnqueue === 0 && (
            <p className="text-sm text-muted-foreground">
              {t("nothingToEnqueue")}
            </p>
          )}
        </div>
      )}

      {/* Enqueue result */}
      {runResult && (
        <div
          role="status"
          className="space-y-1 rounded-md border border-border bg-background p-4 text-sm"
        >
          <p className="font-medium text-foreground">{t("enqueuedTitle")}</p>
          <p className="text-foreground">
            {t("enqueuedSummary", {
              seeded: runResult.seeded,
              requeued: runResult.requeued,
            })}
          </p>
          {runResult.cap_excluded > 0 && (
            <p className="text-muted-foreground">
              {t("capExcludedNote", { count: runResult.cap_excluded })}
            </p>
          )}
        </div>
      )}

      {/* Drain-completion progress (#466 Scope §6) */}
      <div className="space-y-2">
        <div className="flex items-center gap-3">
          <h3 className="text-sm font-semibold text-foreground">
            {t("statusTitle")}
          </h3>
          <Button
            type="button"
            variant="ghost"
            onClick={() => void loadStatus()}
            disabled={statusLoading}
          >
            {statusLoading ? t("statusLoading") : t("refreshStatus")}
          </Button>
        </div>
        {status && (
          <p className="text-sm text-foreground">
            {status.drained
              ? t("drainedYes", { total: status.totalLeaves })
              : t("drainedNo", {
                  outstanding: status.outstanding,
                  total: status.totalLeaves,
                })}
          </p>
        )}
      </div>
    </section>
  );
}
