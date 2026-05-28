"use client";

import { useState } from "react";

interface Props {
  customerId: string;
  storyId: string;
}

/**
 * RFC 0002 Phase 1 (#296) — "Regenerate" button + confirmation modal +
 * status banner. Force-regenerate is operator-initiated and consumes a
 * fresh LLM call, so the modal carries an explicit cost warning before
 * the POST.
 *
 * Wire format matches the regenerate endpoint:
 *   `POST /api/customers/{customer_id}/analysis/story/{story_id}/regenerate`
 * with the CSRF cookie's value sent back as `x-csrf-token`.
 */
export function StoryRegenerateButton({ customerId, storyId }: Props) {
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
      const res = await fetch(
        `/api/customers/${customerId}/analysis/story/${storyId}/regenerate`,
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
        Regenerate
      </button>

      {open ? (
        <div
          role="dialog"
          aria-label="regenerate-modal"
          data-testid="regenerate-modal"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-4"
        >
          <div className="w-full max-w-md rounded-lg bg-card p-5 shadow-lg">
            <h2 className="mb-2 text-lg font-semibold text-foreground">
              Regenerate story analysis?
            </h2>
            <p className="mb-4 text-sm text-muted-foreground">
              This issues a fresh LLM call against the canonical story members
              and overwrites the latest generation when the new result lands.
              The previous result row is preserved with a
              <code>superseded_at</code> stamp.
            </p>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setOpen(false)}
                disabled={busy}
                className="rounded border border-border bg-card px-3 py-2 text-sm text-foreground hover:bg-muted"
              >
                Cancel
              </button>
              <button
                type="button"
                data-testid="regenerate-confirm"
                onClick={submit}
                disabled={busy}
                className="rounded bg-foreground px-3 py-2 text-sm font-medium text-background hover:opacity-90 disabled:opacity-60"
              >
                {busy ? "Submitting…" : "Regenerate"}
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
          Regenerate queued (generation {status.generation}). Refresh the page
          once processing completes.
        </div>
      ) : null}
      {status.kind === "error" ? (
        <div
          role="alert"
          data-testid="regenerate-error"
          className="mt-3 rounded border border-rose-400 bg-rose-50 px-3 py-2 text-sm text-rose-800"
        >
          Could not queue regenerate: {status.message}
        </div>
      ) : null}
    </div>
  );
}
