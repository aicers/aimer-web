"use client";

import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState } from "react";

interface Props {
  locale: string;
  customerId: string;
  aiceId: string;
  eventKey: string;
  /**
   * The active event variant the page was opened with. The event page is
   * variant-specific (it resolves a row by `(aice_id, event_key, lang,
   * model_name, model)`), so the button forwards the current variant and
   * the endpoint regenerates exactly that one (B1). Choosing a *different*
   * model is the out-of-scope B2 picker, so there is no model dropdown here.
   */
  variant: {
    lang: string;
    modelName: string;
    model: string;
  };
}

/**
 * #463 — in-app single-event "Regenerate" button + confirmation modal.
 *
 * Force-regenerate is operator-initiated and consumes a fresh LLM call, so
 * the modal carries an explicit cost warning before the POST. Unlike the
 * story regenerate button (which queues an async job and shows a status
 * banner), event analysis is synchronous: the endpoint returns
 * `200 { generation }` once the new generation is written, so on success
 * this button navigates the current user to the new generation. The target
 * URL is built CLIENT-side from the current locale + variant params — the
 * endpoint stays locale-agnostic so it never reuses the analyze flow's
 * hardcoded `en` permalink locale.
 *
 *   `POST /api/customers/{customerId}/aice/{aiceId}/events/{eventKey}/regenerate`
 * with the CSRF cookie's value sent back as `x-csrf-token`.
 */
export function EventRegenerateButton({
  locale,
  customerId,
  aiceId,
  eventKey,
  variant,
}: Props) {
  const t = useTranslations("analysis");
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<
    | { kind: "idle" }
    | { kind: "navigating"; generation: number }
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
      if (variant.lang) query.set("lang", variant.lang);
      if (variant.modelName) query.set("model_name", variant.modelName);
      if (variant.model) query.set("model", variant.model);
      const qs = query.toString();
      const res = await fetch(
        `/api/customers/${customerId}/aice/${encodeURIComponent(
          aiceId,
        )}/events/${encodeURIComponent(eventKey)}/regenerate${
          qs ? `?${qs}` : ""
        }`,
        {
          method: "POST",
          headers: { "x-csrf-token": csrf },
          credentials: "same-origin",
        },
      );
      if (res.status === 200) {
        const body = (await res.json()) as { generation: number };
        setStatus({ kind: "navigating", generation: body.generation });
        setOpen(false);
        // Build the target URL from the CURRENT locale + variant + the new
        // generation, then refresh so the server component re-resolves it.
        const dest = new URLSearchParams();
        if (variant.lang) dest.set("lang", variant.lang);
        if (variant.modelName) dest.set("model_name", variant.modelName);
        if (variant.model) dest.set("model", variant.model);
        dest.set("generation", String(body.generation));
        router.push(
          `/${locale}/customers/${customerId}/aice/${encodeURIComponent(
            aiceId,
          )}/events/${encodeURIComponent(eventKey)}/analysis?${dest.toString()}`,
        );
        router.refresh();
      } else {
        const body = (await res.json().catch(() => ({}))) as {
          error?: unknown;
          message?: string;
        };
        const message =
          body.message ??
          (typeof body.error === "string" ? body.error : undefined) ??
          `HTTP ${res.status}: failed`;
        setStatus({ kind: "error", message });
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
        data-testid="event-regenerate-button"
        onClick={() => setOpen(true)}
        className="inline-flex items-center rounded border border-border bg-card px-3 py-2 text-sm font-medium text-foreground hover:bg-muted"
      >
        {t("regenerate.button")}
      </button>

      {open ? (
        <div
          role="dialog"
          aria-label={t("regenerate.eventTitle")}
          data-testid="event-regenerate-modal"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-4"
        >
          <div className="w-full max-w-md rounded-lg bg-card p-5 shadow-lg">
            <h2 className="mb-2 text-lg font-semibold text-foreground">
              {t("regenerate.eventTitle")}
            </h2>
            <p className="mb-4 text-sm text-muted-foreground">
              {t.rich("regenerate.eventBody", {
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
                data-testid="event-regenerate-confirm"
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

      {status.kind === "navigating" ? (
        <div
          role="status"
          data-testid="event-regenerate-status"
          className="mt-3 rounded border border-emerald-300 bg-emerald-50 px-3 py-2 text-sm text-emerald-900"
        >
          {t("regenerate.navigating", { generation: status.generation })}
        </div>
      ) : null}
      {status.kind === "error" ? (
        <div
          role="alert"
          data-testid="event-regenerate-error"
          className="mt-3 rounded border border-rose-400 bg-rose-50 px-3 py-2 text-sm text-rose-800"
        >
          {t("regenerate.eventError", { message: status.message })}
        </div>
      ) : null}
    </div>
  );
}
