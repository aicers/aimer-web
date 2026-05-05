"use client";

import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { adminFetch } from "@/lib/api/admin-client";
import { ApiError } from "@/lib/api/client";

interface Thumbprint {
  base64url: string;
  hex: string;
}

interface JwkThumbprintConfirmProps {
  jwkText: string;
  confirmed: boolean;
  onConfirmedChange: (confirmed: boolean) => void;
  onValidityChange?: (valid: boolean) => void;
  disabled?: boolean;
}

/**
 * Server-recomputes the JWK Thumbprint for a pasted JWK and renders both the
 * base64url and colon-separated hex formats untruncated, alongside a
 * confirmation checkbox the operator must toggle before the parent form's
 * submit becomes enabled. Any change to `jwkText` clears the confirmation,
 * hides the thumbprint, and notifies the parent via `onConfirmedChange`.
 */
export function JwkThumbprintConfirm({
  jwkText,
  confirmed,
  onConfirmedChange,
  onValidityChange,
  disabled,
}: JwkThumbprintConfirmProps) {
  const t = useTranslations("adminEnvironments");

  const [thumbprint, setThumbprint] = useState<Thumbprint | null>(null);
  const [computing, setComputing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<"base64url" | "hex" | null>(null);

  // Recompute whenever the JWK input changes. Reset confirmation + UI state.
  useEffect(() => {
    setThumbprint(null);
    setError(null);
    onConfirmedChange(false);
    onValidityChange?.(false);

    const trimmed = jwkText.trim();
    if (!trimmed) {
      setComputing(false);
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      setError(t("invalidPublicKey"));
      setComputing(false);
      return;
    }

    const controller = new AbortController();
    setComputing(true);
    (async () => {
      try {
        const result = await adminFetch<Thumbprint>(
          "/api/admin/trust-registry/thumbprint",
          {
            method: "POST",
            body: JSON.stringify({ publicKey: parsed }),
            signal: controller.signal,
          },
        );
        if (controller.signal.aborted) return;
        setThumbprint(result);
        setError(null);
        setComputing(false);
        onValidityChange?.(true);
      } catch (err) {
        if (controller.signal.aborted) return;
        if (err instanceof ApiError) {
          setError(err.message);
        } else {
          setError(t("thumbprintError"));
        }
        setComputing(false);
      }
    })();

    return () => {
      controller.abort();
    };
  }, [jwkText, t, onConfirmedChange, onValidityChange]);

  const copy = async (value: string, which: "base64url" | "hex") => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(which);
      setTimeout(
        () => setCopied((current) => (current === which ? null : current)),
        2000,
      );
    } catch {
      // Clipboard access denied — silently ignore; operator can still select.
    }
  };

  if (!jwkText.trim()) return null;

  if (computing) {
    return (
      <div className="rounded-md border border-border bg-muted/30 p-3 text-sm text-muted-foreground">
        {t("thumbprintComputing")}
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">
        {error}
      </div>
    );
  }

  if (!thumbprint) return null;

  return (
    <div className="space-y-3 rounded-md border border-border bg-muted/30 p-3">
      <div>
        <p className="text-sm font-medium text-foreground">
          {t("thumbprintTitle")}
        </p>
        <p className="text-xs text-muted-foreground">
          {t("thumbprintInstruction")}
        </p>
      </div>

      <div className="space-y-1">
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {t("thumbprintBase64Url")}
          </span>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={disabled}
            onClick={() => copy(thumbprint.base64url, "base64url")}
          >
            {copied === "base64url" ? t("copied") : t("copy")}
          </Button>
        </div>
        <code className="block break-all rounded bg-background px-2 py-1 font-mono text-sm text-foreground">
          {thumbprint.base64url}
        </code>
      </div>

      <div className="space-y-1">
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {t("thumbprintHex")}
          </span>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={disabled}
            onClick={() => copy(thumbprint.hex, "hex")}
          >
            {copied === "hex" ? t("copied") : t("copy")}
          </Button>
        </div>
        <code className="block break-all rounded bg-background px-2 py-1 font-mono text-sm text-foreground">
          {thumbprint.hex}
        </code>
      </div>

      <label className="flex items-start gap-2 text-sm font-medium text-foreground">
        <input
          type="checkbox"
          className="mt-0.5 h-4 w-4 rounded border-input"
          checked={confirmed}
          disabled={disabled}
          onChange={(e) => onConfirmedChange(e.target.checked)}
        />
        <span>{t("thumbprintConfirm")}</span>
      </label>
    </div>
  );
}
