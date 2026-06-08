"use client";

// Operator-facing report-variant refresh controls (#469 Scope §7).
//
// The THIRD re-analysis panel, alongside the story (#466) and event (#470)
// leaf-backfill panels on the same surface. It refreshes scoped periodic
// report variants under the customer's new default model (a generation bump
// the existing report worker drains) so they re-aggregate the freshly
// re-analyzed leaves. Each variant is auto-gated on BOTH leaf drain signals
// over its own per-period window, so a refresh launched before the leaf
// backfills drain reports those variants as `gated` rather than refreshing a
// stale leaf set.
//
// Drives the preview → required-confirm → run → outcome flow against the
// report-refresh API. Shared by both surfaces: the admin page passes
// `adminFetch` + `/api/admin/...`; the analyst page passes `apiFetch` +
// `/api/customers/.../analysis/...`. The cost preview shows counts/scope
// only — never a monetary figure. A run is synchronous (no background
// worker), so its outcome is shown immediately on completion.

import { useLocale, useTranslations } from "next-intl";
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";

interface RefreshCounts {
  totalVariants: number;
  refreshed: number;
  capped: number;
  gated: number;
  alreadyQueued: number;
  sourceUnavailable: number;
  limited: number;
}

interface TargetVariant {
  lang: string;
  modelName: string;
  model: string;
}

interface PreviewResponse {
  target: TargetVariant;
  windowDays: number;
  /** Timezone-variant scope, or `null` for all timezones in the window. */
  tz: string | null;
  counts: RefreshCounts;
}

type RunStatus = "running" | "completed" | "failed";

interface RefreshRun extends RefreshCounts {
  id: string;
  status: RunStatus;
  lang: string;
  modelName: string;
  model: string;
  tz: string | null;
  windowDays: number;
}

const DEFAULT_WINDOW_DAYS = 7;

const PERIODS = ["LIVE", "DAILY", "WEEKLY", "MONTHLY"] as const;
type Period = (typeof PERIODS)[number];

const LANGS = ["ENGLISH", "KOREAN"] as const;
type Lang = (typeof LANGS)[number];

function localeToLang(locale: string): Lang {
  return locale.toLowerCase().startsWith("ko") ? "KOREAN" : "ENGLISH";
}

/**
 * Parse an operator-entered positive-integer field. Empty string → the
 * supplied fallback; anything that is not a positive integer → `"invalid"`.
 */
function parsePositiveField(
  raw: string,
  empty: number | null,
): number | null | "invalid" {
  const trimmed = raw.trim();
  if (trimmed === "") return empty;
  const n = Number(trimmed);
  if (!Number.isInteger(n) || n <= 0) return "invalid";
  return n;
}

export interface ReportVariantRefreshPanelProps {
  /** Whether the customer id is known yet (gates fetching). */
  customerId: string | null;
  /** API base, e.g. `/api/admin/customers/{id}/report-refresh`. */
  apiBase: string;
  /** Context-appropriate fetch wrapper (adminFetch / apiFetch). */
  fetcher: <T>(url: string, options?: RequestInit) => Promise<T>;
}

export function ReportVariantRefreshPanel({
  customerId,
  apiBase,
  fetcher,
}: ReportVariantRefreshPanelProps) {
  const t = useTranslations("reportVariantRefresh");
  const locale = useLocale();

  const langLabel = useCallback(
    (lang: string) => (lang === "KOREAN" ? t("langKorean") : t("langEnglish")),
    [t],
  );

  // A blank timezone scope means "all timezone variants in the window" — show
  // that explicitly rather than an empty value (review feedback: the
  // all-timezone default must be visible, not silent).
  const tzLabel = useCallback(
    (tz: string | null) => (tz?.trim() ? tz : t("tzAll")),
    [t],
  );

  // Static (literal-key) period labels — next-intl requires literal message
  // keys, so a dynamically-built `period${p}` key does not type-check.
  const periodLabel = useCallback(
    (p: Period) => {
      switch (p) {
        case "LIVE":
          return t("periodLive");
        case "DAILY":
          return t("periodDaily");
        case "WEEKLY":
          return t("periodWeekly");
        default:
          return t("periodMonthly");
      }
    },
    [t],
  );

  const [preview, setPreview] = useState<PreviewResponse | null>(null);
  const [previewError, setPreviewError] = useState(false);
  const [run, setRun] = useState<RefreshRun | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const [windowDaysInput, setWindowDaysInput] = useState(
    String(DEFAULT_WINDOW_DAYS),
  );
  const [maxVariantsInput, setMaxVariantsInput] = useState("");
  const [langInput, setLangInput] = useState<Lang>(localeToLang(locale));
  // Optional timezone-variant scope (Scope §2). Blank → all timezones in the
  // recent window (the conservative default); a value targets one tz variant.
  const [tzInput, setTzInput] = useState("");
  // Periods in scope (Scope §2). All selected by default; the operator can
  // narrow to specific periods.
  const [periods, setPeriods] = useState<Set<Period>>(new Set(PERIODS));
  const [scopeError, setScopeError] = useState(false);

  const togglePeriod = useCallback((p: Period) => {
    setPeriods((prev) => {
      const next = new Set(prev);
      if (next.has(p)) next.delete(p);
      else next.add(p);
      return next;
    });
  }, []);

  const buildScopeParams = useCallback((): URLSearchParams | null => {
    const windowDays = parsePositiveField(windowDaysInput, DEFAULT_WINDOW_DAYS);
    const maxVariants = parsePositiveField(maxVariantsInput, null);
    if (
      windowDays === "invalid" ||
      windowDays == null ||
      maxVariants === "invalid" ||
      periods.size === 0
    ) {
      setScopeError(true);
      return null;
    }
    setScopeError(false);
    const params = new URLSearchParams({
      window_days: String(windowDays),
      lang: langInput,
      periods: PERIODS.filter((p) => periods.has(p)).join(","),
    });
    if (maxVariants != null) params.set("max_variants", String(maxVariants));
    const tz = tzInput.trim();
    if (tz) params.set("tz", tz);
    return params;
  }, [windowDaysInput, maxVariantsInput, langInput, periods, tzInput]);

  const loadPreview = useCallback(async () => {
    if (!customerId) return;
    const params = buildScopeParams();
    if (!params) return;
    try {
      const data = await fetcher<PreviewResponse>(
        `${apiBase}/preview?${params.toString()}`,
      );
      setPreview(data);
      setPreviewError(false);
    } catch {
      setPreviewError(true);
    }
  }, [apiBase, customerId, fetcher, buildScopeParams]);

  const loadLastRun = useCallback(async () => {
    if (!customerId) return;
    try {
      const data = await fetcher<{ runs: RefreshRun[] }>(apiBase);
      setRun(data.runs[0] ?? null);
    } catch {
      // Non-fatal — the preview still renders.
    }
  }, [apiBase, customerId, fetcher]);

  useEffect(() => {
    void loadPreview();
    void loadLastRun();
  }, [loadPreview, loadLastRun]);

  const start = useCallback(async () => {
    if (!customerId) return;
    const windowDays = parsePositiveField(windowDaysInput, DEFAULT_WINDOW_DAYS);
    const maxVariants = parsePositiveField(maxVariantsInput, null);
    if (
      windowDays === "invalid" ||
      windowDays == null ||
      maxVariants === "invalid" ||
      periods.size === 0
    ) {
      setScopeError(true);
      return;
    }
    setSubmitting(true);
    setActionError(null);
    try {
      const body: Record<string, unknown> = {
        windowDays,
        lang: langInput,
        periods: PERIODS.filter((p) => periods.has(p)),
        confirm: true,
      };
      if (maxVariants != null) body.maxVariants = maxVariants;
      const tz = tzInput.trim();
      if (tz) body.tz = tz;
      const data = await fetcher<{ run: RefreshRun }>(apiBase, {
        method: "POST",
        body: JSON.stringify(body),
      });
      setRun(data.run);
      setConfirming(false);
    } catch {
      setActionError(t("startError"));
    } finally {
      setSubmitting(false);
    }
  }, [
    apiBase,
    customerId,
    fetcher,
    t,
    windowDaysInput,
    maxVariantsInput,
    langInput,
    periods,
    tzInput,
  ]);

  // Categorized outcome counts for a run — stays visible after completion so
  // the refreshed / capped / gated / already-queued / source-unavailable /
  // limited breakdown is an auditable no-silent-caps record (Scope §5).
  const renderRunCounts = (r: RefreshCounts) => (
    <ul className="text-sm text-muted-foreground">
      <li>{t("countRefreshed", { n: r.refreshed })}</li>
      <li>{t("countGated", { n: r.gated })}</li>
      <li>{t("countAlreadyQueued", { n: r.alreadyQueued })}</li>
      <li>{t("countCapped", { n: r.capped })}</li>
      <li>{t("countSourceUnavailable", { n: r.sourceUnavailable })}</li>
      <li>{t("countLimited", { n: r.limited })}</li>
    </ul>
  );

  return (
    <section className="space-y-3 rounded-md border border-border bg-card p-4">
      <h2 className="text-base font-semibold text-foreground">
        {t("panelTitle")}
      </h2>
      <p className="text-sm text-muted-foreground">{t("panelDescription")}</p>
      <p className="text-xs text-muted-foreground">{t("gateNote")}</p>

      {run && (
        <div className="space-y-1 rounded-md border border-border p-3">
          <p className="text-sm font-medium text-foreground">
            {t("lastRunStatus", { status: t(`status_${run.status}`) })}
          </p>
          <p className="text-xs text-muted-foreground">
            {t("lastRunScope", {
              days: run.windowDays,
              lang: langLabel(run.lang),
              model: `${run.modelName} / ${run.model}`,
              tz: tzLabel(run.tz),
            })}
          </p>
          {renderRunCounts(run)}
        </div>
      )}

      <div className="flex flex-wrap gap-3">
        <label
          htmlFor="report-refresh-lang"
          className="flex flex-col gap-1 text-sm text-foreground"
        >
          <span>{t("langLabel")}</span>
          <Select
            id="report-refresh-lang"
            className="w-40"
            value={langInput}
            onChange={(e) => setLangInput(e.target.value as Lang)}
          >
            {LANGS.map((l) => (
              <option key={l} value={l}>
                {langLabel(l)}
              </option>
            ))}
          </Select>
        </label>
        <label
          htmlFor="report-refresh-window-days"
          className="flex flex-col gap-1 text-sm text-foreground"
        >
          <span>{t("windowDaysLabel")}</span>
          <Input
            id="report-refresh-window-days"
            type="number"
            min={1}
            inputMode="numeric"
            className="w-28"
            value={windowDaysInput}
            onChange={(e) => setWindowDaysInput(e.target.value)}
          />
        </label>
        <label
          htmlFor="report-refresh-max-variants"
          className="flex flex-col gap-1 text-sm text-foreground"
        >
          <span>{t("maxVariantsLabel")}</span>
          <Input
            id="report-refresh-max-variants"
            type="number"
            min={1}
            inputMode="numeric"
            className="w-28"
            placeholder={t("maxVariantsPlaceholder")}
            value={maxVariantsInput}
            onChange={(e) => setMaxVariantsInput(e.target.value)}
          />
        </label>
        <label
          htmlFor="report-refresh-tz"
          className="flex flex-col gap-1 text-sm text-foreground"
        >
          <span>{t("tzLabel")}</span>
          <Input
            id="report-refresh-tz"
            type="text"
            className="w-44"
            placeholder={t("tzPlaceholder")}
            value={tzInput}
            onChange={(e) => setTzInput(e.target.value)}
          />
        </label>
      </div>

      <fieldset className="space-y-1">
        <legend className="text-sm text-foreground">{t("periodsLabel")}</legend>
        <div className="flex flex-wrap gap-3">
          {PERIODS.map((p) => (
            <label
              key={p}
              className="flex items-center gap-1 text-sm text-muted-foreground"
            >
              <input
                type="checkbox"
                checked={periods.has(p)}
                onChange={() => togglePeriod(p)}
              />
              <span>{periodLabel(p)}</span>
            </label>
          ))}
        </div>
      </fieldset>

      <p className="text-xs text-muted-foreground">{t("scopeHint")}</p>
      {scopeError && (
        <p className="text-sm text-destructive">{t("scopeError")}</p>
      )}

      {previewError ? (
        <p className="text-sm text-destructive">{t("previewError")}</p>
      ) : preview ? (
        <div className="space-y-2">
          <p className="text-sm font-medium text-foreground">
            {t("countsTitle", { days: preview.windowDays })}
          </p>
          <p className="text-xs text-muted-foreground">
            {t("targetSummary", {
              lang: langLabel(preview.target.lang),
              model: `${preview.target.modelName} / ${preview.target.model}`,
              tz: tzLabel(preview.tz),
            })}
          </p>
          <ul className="text-sm text-muted-foreground">
            <li>{t("countTotal", { n: preview.counts.totalVariants })}</li>
            <li>{t("countToRefresh", { n: preview.counts.refreshed })}</li>
            <li>{t("countGated", { n: preview.counts.gated })}</li>
            <li>
              {t("countAlreadyQueued", { n: preview.counts.alreadyQueued })}
            </li>
            <li>{t("countCapped", { n: preview.counts.capped })}</li>
            <li>
              {t("countSourceUnavailable", {
                n: preview.counts.sourceUnavailable,
              })}
            </li>
            <li>{t("countLimited", { n: preview.counts.limited })}</li>
          </ul>
          <p className="text-xs text-muted-foreground">{t("noMonetaryNote")}</p>
          {preview.counts.refreshed === 0 ? (
            <p className="text-sm text-muted-foreground">{t("nothingToDo")}</p>
          ) : confirming ? (
            <div className="space-y-2 rounded-md border border-border p-3">
              <p className="text-sm text-foreground">
                {t("confirmBody", {
                  n: preview.counts.refreshed,
                  lang: langLabel(preview.target.lang),
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
              {t("refreshButton", { n: preview.counts.refreshed })}
            </Button>
          )}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">{t("previewLoading")}</p>
      )}
      {actionError && <p className="text-sm text-destructive">{actionError}</p>}
    </section>
  );
}
