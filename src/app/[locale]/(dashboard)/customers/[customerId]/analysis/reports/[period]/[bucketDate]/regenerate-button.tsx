"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";

interface Props {
  customerId: string;
  period: string;
  bucketDate: string;
  /**
   * The active report variant the page was opened with. Forwarded on the
   * regenerate POST as `?tz=&lang=&model_name=&model=` so a non-default
   * report is regenerated as that same variant instead of the default.
   */
  variant?: {
    tz?: string;
    lang?: string;
    model_name?: string;
    model?: string;
  };
}

/**
 * RFC 0002 Phase 2 (#297) — "Regenerate" button + confirmation modal +
 * status banner for a periodic report. Force-regenerate is
 * operator-initiated and consumes a fresh LLM call, so the modal carries
 * an explicit cost warning before the POST.
 *
 * Wire format matches the regenerate endpoint:
 *   `POST /api/customers/{customer_id}/analysis/report/{period}/{bucket_date}/regenerate`
 * with the CSRF cookie's value sent back as `x-csrf-token`.
 */
export function ReportRegenerateButton({
  customerId,
  period,
  bucketDate,
  variant,
}: Props) {
  const t = useTranslations("analysis");
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<
    | { kind: "idle" }
    | { kind: "queued"; generation: number }
    | { kind: "error"; message: string }
  >({ kind: "idle" });

  async function submit() {
    setBusy(true);
    try {
      const csrf =
        document.cookie
          .split("; ")
          .find((c) => c.startsWith("csrf="))
          ?.slice("csrf=".length) ?? "";
      const query = new URLSearchParams();
      if (variant?.tz) query.set("tz", variant.tz);
      if (variant?.lang) query.set("lang", variant.lang);
      if (variant?.model_name) query.set("model_name", variant.model_name);
      if (variant?.model) query.set("model", variant.model);
      const qs = query.toString();
      const res = await fetch(
        `/api/customers/${customerId}/analysis/report/${period}/${bucketDate}/regenerate${
          qs ? `?${qs}` : ""
        }`,
        {
          method: "POST",
          headers: { "x-csrf-token": csrf },
          credentials: "same-origin",
        },
      );
      if (res.status === 202) {
        const body = (await res.json()) as { generation: number };
        setStatus({ kind: "queued", generation: body.generation });
        setOpen(false);
      } else {
        const body = (await res.json().catch(() => ({}))) as {
          error?: string;
          message?: string;
        };
        setStatus({
          kind: "error",
          message: body.message ?? body.error ?? `HTTP ${res.status}: failed`,
        });
      }
    } catch (err) {
      setStatus({
        kind: "error",
        message: err instanceof Error ? err.message : "request failed",
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <button
        type="button"
        data-testid="regenerate-button"
        onClick={() => setOpen(true)}
        className="inline-flex items-center rounded border border-border bg-card px-3 py-2 text-sm font-medium text-foreground hover:bg-muted"
      >
        {t("regenerate.button")}
      </button>

      {open ? (
        <div
          role="dialog"
          aria-label={t("regenerate.reportTitle")}
          data-testid="regenerate-modal"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-4"
        >
          <div className="w-full max-w-md rounded-lg bg-card p-5 shadow-lg">
            <h2 className="mb-2 text-lg font-semibold text-foreground">
              {t("regenerate.reportTitle")}
            </h2>
            <p className="mb-4 text-sm text-muted-foreground">
              {t.rich("regenerate.reportBody", {
                code: (chunks) => <code>{chunks}</code>,
              })}
            </p>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setOpen(false)}
                disabled={busy}
                className="rounded border border-border bg-card px-3 py-2 text-sm text-foreground hover:bg-muted"
              >
                {t("regenerate.cancel")}
              </button>
              <button
                type="button"
                data-testid="regenerate-confirm"
                onClick={submit}
                disabled={busy}
                className="rounded bg-foreground px-3 py-2 text-sm font-medium text-background hover:opacity-90 disabled:opacity-60"
              >
                {busy ? t("regenerate.submitting") : t("regenerate.button")}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {status.kind === "queued" ? (
        <div
          role="status"
          data-testid="regenerate-status"
          className="mt-3 rounded border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900"
        >
          {t("regenerate.queued", { generation: status.generation })}
        </div>
      ) : null}
      {status.kind === "error" ? (
        <div
          role="alert"
          data-testid="regenerate-error"
          className="mt-3 rounded border border-rose-400 bg-rose-50 px-3 py-2 text-sm text-rose-800"
        >
          {t("regenerate.error", { message: status.message })}
        </div>
      ) : null}
    </div>
  );
}
