"use client";

import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState } from "react";
import {
  initialModelIndex,
  type ModelOption,
  ModelSelect,
} from "@/components/analysis/model-select";
import { reportLanguageToAppLocale } from "@/i18n/locale";
import { subjectApi, subjectPages } from "@/lib/navigation/routes";

interface Props {
  locale: string;
  customerId: string;
  aiceId: string;
  eventKey: string;
  /**
   * The active event variant the page was opened with. The event page is
   * variant-specific (it resolves a row by `(aice_id, event_key, lang,
   * model_name, model)`), so the button forwards the current variant. `lang`
   * is held constant (the model axis only); `model_name`/`model` seed the
   * picker default unless overridden by `defaultModel` (#464).
   */
  variant: {
    lang: string;
    modelName: string;
    model: string;
  };
  /**
   * Analyst-only model catalog (#464), passed down from the server page (the
   * catalog module is server-only). When present, the modal shows a model
   * dropdown and the chosen `(model_name, model)` is submitted on the POST and
   * used to build the post-success navigation URL — so an analyst can
   * regenerate a *different* (non-current) model variant (the "B2" picker).
   */
  models?: ModelOption[];
  /**
   * Preselect this `(modelName, model)` in the dropdown instead of the current
   * variant's model. Used by the compare "variant not generated" CTA (#464).
   */
  defaultModel?: { modelName: string; model: string };
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
 *   `POST /api/subjects/{customerId}/aice/{aiceId}/events/{eventKey}/regenerate`
 * with the CSRF cookie's value sent back as `x-csrf-token`.
 */
export function EventRegenerateButton({
  locale,
  customerId,
  aiceId,
  eventKey,
  variant,
  models,
  defaultModel,
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
  // The pair the dropdown should preselect: the compare-target model for the
  // compare "not generated" CTA, otherwise the current variant's model.
  const preferred = defaultModel ?? {
    modelName: variant.modelName,
    model: variant.model,
  };
  const preferredKey = `${preferred.modelName}/${preferred.model}`;
  const [modelIndex, setModelIndex] = useState(() =>
    initialModelIndex(models ?? [], preferred),
  );
  // App Router soft navigations that only change search params (e.g. switching
  // the compare model via the compare selector, or opening a different variant)
  // keep this client component mounted, so the lazy `useState` initializer
  // above does NOT re-run when `defaultModel`/`variant` change. Without
  // resyncing, the picker would keep a stale `modelIndex` and a submit without
  // touching the dropdown would POST the previously-targeted model instead of
  // the newly-selected one (#464). Reset the index when the preferred pair
  // changes — the React "adjusting state when a prop changes" pattern, no
  // effect needed. The catalog (`models`) is config-driven and stable across
  // navigations, so tracking the preferred pair alone is sufficient.
  const [prevPreferredKey, setPrevPreferredKey] = useState(preferredKey);
  if (prevPreferredKey !== preferredKey) {
    setPrevPreferredKey(preferredKey);
    setModelIndex(initialModelIndex(models ?? [], preferred));
  }

  async function submit() {
    setBusy(true);
    try {
      const csrf =
        document.cookie
          .split("; ")
          .find((c) => c.startsWith("csrf="))
          ?.slice("csrf=".length) ?? "";
      // The model comes from the picker when a catalog is present (#464),
      // letting an analyst regenerate a different model variant; `lang` stays
      // the current variant's (model axis only). The endpoint already accepts
      // `?lang=&model_name=&model=` and regenerates exactly that variant.
      const chosen = models?.[modelIndex];
      const modelName = chosen?.modelName ?? variant.modelName;
      const model = chosen?.model ?? variant.model;
      const query = new URLSearchParams();
      if (variant.lang) query.set("lang", variant.lang);
      if (modelName) query.set("model_name", modelName);
      if (model) query.set("model", model);
      const qs = query.toString();
      const res = await fetch(
        `${subjectApi.eventRegenerate(
          customerId,
          encodeURIComponent(aiceId),
          encodeURIComponent(eventKey),
        )}${qs ? `?${qs}` : ""}`,
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
        // Build the target URL from the CURRENT locale + the CHOSEN model
        // (the regenerated variant) + the new generation, then refresh so the
        // server component re-resolves it. When the analyst picked a different
        // model, the new generation belongs to that variant, so the view URL
        // must point at the chosen model — not the originally-open one (#464).
        const dest = new URLSearchParams();
        // The reader `?lang` is the locale form (`en`/`ko`), cross-compatible
        // with report/story links (#581); the regenerate API above keeps the
        // enum contract.
        if (variant.lang === "KOREAN" || variant.lang === "ENGLISH") {
          dest.set("lang", reportLanguageToAppLocale(variant.lang));
        }
        if (modelName) dest.set("model_name", modelName);
        if (model) dest.set("model", model);
        dest.set("generation", String(body.generation));
        router.push(
          `${subjectPages.eventAnalysis(
            locale,
            customerId,
            encodeURIComponent(aiceId),
            encodeURIComponent(eventKey),
          )}?${dest.toString()}`,
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
            {models && models.length > 0 ? (
              <ModelSelect
                id="event-regenerate-model"
                label={t("regenerate.modelLabel")}
                models={models}
                selectedIndex={modelIndex}
                onSelect={setModelIndex}
                disabled={busy}
              />
            ) : null}
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
