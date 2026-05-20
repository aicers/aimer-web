"use client";

import { useTranslations } from "next-intl";
import { useCallback, useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { apiFetch } from "@/lib/api/client";

export interface RedactionRange {
  id: string;
  cidr: string;
  ipVersion: number;
  createdAt: string;
}

export interface RedactionPreview {
  stale_row_count: number;
  estimated_duration_seconds: number;
  target_policy_version: string;
}

interface TriggerResponse {
  job_id: string;
  status: string;
  target_policy_version: string;
}

interface Props {
  customerId: string;
  canWrite: boolean;
}

export function RedactionRangesSection({ customerId, canWrite }: Props) {
  const t = useTranslations("customerSettings");

  const [ranges, setRanges] = useState<RedactionRange[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [cidrInput, setCidrInput] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  // Apply-to-existing-data modal state
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [preview, setPreview] = useState<RedactionPreview | null>(null);
  const [triggering, setTriggering] = useState(false);
  const [triggerError, setTriggerError] = useState<string | null>(null);
  const [triggeredJob, setTriggeredJob] = useState<TriggerResponse | null>(
    null,
  );

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const data = await apiFetch<{ ranges: RedactionRange[] }>(
        `/api/admin/customers/${customerId}/redaction-ranges`,
      );
      setRanges(data.ranges);
      setError(null);
    } catch {
      setError(t("rangesLoadError"));
    } finally {
      setLoading(false);
    }
  }, [customerId, t]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const handleAdd = useCallback(
    async (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (!cidrInput.trim()) return;
      setSubmitting(true);
      setSubmitError(null);
      try {
        await apiFetch(`/api/admin/customers/${customerId}/redaction-ranges`, {
          method: "POST",
          body: JSON.stringify({ cidr: cidrInput.trim() }),
        });
        setCidrInput("");
        await reload();
      } catch (err) {
        const code = err instanceof Error ? err.message : "";
        setSubmitError(rangeErrorLabel(code, t));
      } finally {
        setSubmitting(false);
      }
    },
    [cidrInput, customerId, reload, t],
  );

  const handleDelete = useCallback(
    async (rangeId: string) => {
      try {
        await apiFetch(
          `/api/admin/customers/${customerId}/redaction-ranges/${rangeId}`,
          { method: "DELETE" },
        );
        await reload();
      } catch {
        setError(t("rangeDeleteError"));
      }
    },
    [customerId, reload, t],
  );

  const openPreview = useCallback(async () => {
    setPreviewOpen(true);
    setPreview(null);
    setPreviewError(null);
    setPreviewLoading(true);
    setTriggerError(null);
    setTriggeredJob(null);
    try {
      const data = await apiFetch<RedactionPreview>(
        `/api/admin/customers/${customerId}/redaction-jobs/preview`,
      );
      setPreview(data);
    } catch {
      // Surface the failure instead of synthesising a zero-row
      // preview — the operator must not be able to trigger a job
      // without a successful preflight, since the dialog's row count
      // and policy-version stamp come from this response.
      setPreviewError(t("applyExistingPreviewError"));
    } finally {
      setPreviewLoading(false);
    }
  }, [customerId, t]);

  const closePreview = useCallback(() => {
    setPreviewOpen(false);
    setPreview(null);
    setPreviewError(null);
    setPreviewLoading(false);
    setTriggerError(null);
    setTriggeredJob(null);
  }, []);

  const confirmTrigger = useCallback(async () => {
    setTriggering(true);
    setTriggerError(null);
    try {
      const job = await apiFetch<TriggerResponse>(
        `/api/admin/customers/${customerId}/redaction-jobs`,
        { method: "POST" },
      );
      setTriggeredJob(job);
    } catch (err) {
      const code = err instanceof Error ? err.message : "";
      setTriggerError(triggerErrorLabel(code, t));
    } finally {
      setTriggering(false);
    }
  }, [customerId, t]);

  return (
    <section className="space-y-4">
      <header>
        <h2 className="text-lg font-semibold text-foreground">
          {t("rangesTitle")}
        </h2>
        <p className="text-sm text-muted-foreground">
          {t("rangesDescription")}
        </p>
      </header>

      {loading && (
        <p className="text-sm text-muted-foreground">{t("loading")}</p>
      )}
      {error && <p className="text-sm text-destructive">{error}</p>}

      {!loading && ranges.length === 0 && (
        <div
          role="status"
          className="rounded-md border border-border bg-muted/40 px-4 py-3 text-sm text-foreground"
        >
          {t("rangesEmptyBanner")}
        </div>
      )}

      {!loading && ranges.length > 0 && (
        <ul className="divide-y divide-border rounded-md border border-border">
          {ranges.map((r) => (
            <li
              key={r.id}
              className="flex items-center justify-between px-4 py-2"
            >
              <span className="font-mono text-sm">{r.cidr}</span>
              {canWrite && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => handleDelete(r.id)}
                  aria-label={t("rangeDeleteAriaLabel", { cidr: r.cidr })}
                >
                  {t("delete")}
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}

      {canWrite && (
        <form onSubmit={handleAdd} className="flex flex-col gap-2 sm:flex-row">
          <Input
            value={cidrInput}
            onChange={(e) => setCidrInput(e.target.value)}
            placeholder={t("rangeAddPlaceholder")}
            aria-label={t("rangeAddLabel")}
            disabled={submitting}
          />
          <Button type="submit" disabled={submitting || !cidrInput.trim()}>
            {t("rangeAddButton")}
          </Button>
        </form>
      )}
      {submitError && <p className="text-sm text-destructive">{submitError}</p>}

      {canWrite && (
        <div className="pt-2">
          <Button
            variant="outline"
            onClick={openPreview}
            aria-label={t("applyExistingButton")}
          >
            {t("applyExistingButton")}
          </Button>
        </div>
      )}

      {previewOpen && (
        <div
          role="dialog"
          aria-label={t("applyExistingPreviewTitle")}
          className="space-y-2 rounded-md border border-border bg-card p-4 text-sm"
        >
          <p className="font-medium">{t("applyExistingPreviewTitle")}</p>
          {previewLoading && (
            <p className="text-sm text-muted-foreground">{t("loading")}</p>
          )}
          {previewError && (
            <p
              role="alert"
              className="text-sm text-destructive"
              data-testid="preview-error"
            >
              {previewError}
            </p>
          )}
          {preview && (
            <>
              <p>
                {t("applyExistingPreviewStaleRows", {
                  n: preview.stale_row_count,
                })}
              </p>
              <p>
                {t("applyExistingPreviewEstimate", {
                  s: preview.estimated_duration_seconds,
                })}
              </p>
            </>
          )}
          {triggeredJob && (
            <p
              role="status"
              className="text-sm text-foreground"
              data-testid="trigger-status"
            >
              {t("applyExistingJobQueued", {
                status: triggeredJob.status,
              })}
            </p>
          )}
          {triggerError && (
            <p className="text-sm text-destructive">{triggerError}</p>
          )}
          <div className="flex gap-2 pt-2">
            {!triggeredJob && preview && (
              <Button
                variant="default"
                size="sm"
                onClick={confirmTrigger}
                disabled={triggering}
              >
                {triggering
                  ? t("applyExistingConfirming")
                  : t("applyExistingConfirm")}
              </Button>
            )}
            <Button variant="ghost" size="sm" onClick={closePreview}>
              {triggeredJob ? t("close") : t("cancel")}
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}

type TFn = ReturnType<typeof useTranslations<"customerSettings">>;

function rangeErrorLabel(code: string, t: TFn): string {
  switch (code) {
    case "cidr_invalid":
      return t("rangeErrorInvalid");
    case "cidr_private":
      return t("rangeErrorPrivate");
    case "cidr_duplicate":
      return t("rangeErrorDuplicate");
    case "cidr_overlaps":
      return t("rangeErrorOverlaps");
    case "cidr_cap_exceeded":
      return t("rangeErrorCapExceeded");
    default:
      return t("rangeAddGenericError");
  }
}

function triggerErrorLabel(_code: string, t: TFn): string {
  return t("applyExistingTriggerGenericError");
}
