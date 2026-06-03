"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

export type LanguageJobStatus =
  | "queued"
  | "processing"
  | "done"
  | "failed"
  | "source_pending";

interface Props {
  /**
   * Read-only status endpoint for the requested language's on-demand job.
   * Polled while the job is `queued`/`processing`; it never enqueues, so a
   * failed job settles to `failed` instead of being retried on every poll
   * (no infinite spinner — #388 phase 2).
   */
  statusUrl: string;
  /** Initial status seeded by the loader's enqueue result. */
  initialStatus: LanguageJobStatus;
  /** Pre-localized banner strings (interpolated with the requested language). */
  labels: {
    /** Shown while `queued` / `processing`. */
    preparing: string;
    /** Shown when the job `failed`. */
    failed: string;
    /** Shown when the bucket itself is still pending (no job). */
    pendingSource: string;
  };
  /** Poll cadence; defaults to 5s. */
  intervalMs?: number;
}

/**
 * Non-blocking status banner for a not-yet-available report language. While
 * the on-demand job is in flight it polls a read-only status endpoint and,
 * when the job reaches `done`, refreshes the route so the now-available
 * variant renders. A `failed` job surfaces a non-blocking error and stops
 * polling; `source_pending` is a static notice (the bucket's settle window
 * has not elapsed, so no job exists to poll).
 */
export function ReportLanguageStatus({
  statusUrl,
  initialStatus,
  labels,
  intervalMs = 5000,
}: Props) {
  const router = useRouter();
  const [status, setStatus] = useState<LanguageJobStatus>(initialStatus);

  useEffect(() => {
    if (status !== "queued" && status !== "processing") return;
    let cancelled = false;
    const tick = async () => {
      try {
        const res = await fetch(statusUrl, {
          credentials: "same-origin",
          cache: "no-store",
        });
        if (!res.ok || cancelled) return;
        const body = (await res.json()) as {
          status?: LanguageJobStatus | null;
        };
        if (cancelled || !body.status) return;
        if (body.status === "done") {
          // The variant now exists — reload the route to render it.
          router.refresh();
          return;
        }
        setStatus(body.status);
      } catch {
        // Transient fetch error — keep the current status and retry next tick.
      }
    };
    const id = setInterval(tick, intervalMs);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [status, statusUrl, intervalMs, router]);

  if (status === "done") return null;

  if (status === "failed") {
    return (
      <div
        role="alert"
        data-testid="report-language-status"
        data-status="failed"
        className="mt-4 rounded border border-rose-400 bg-rose-50 px-4 py-3 text-sm text-rose-800"
      >
        {labels.failed}
      </div>
    );
  }

  const message =
    status === "source_pending" ? labels.pendingSource : labels.preparing;
  return (
    <div
      role="status"
      data-testid="report-language-status"
      data-status={status}
      className="mt-4 rounded border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900"
    >
      {message}
    </div>
  );
}
