"use client";

import { useParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { useCustomerContext } from "@/hooks/use-customer-context";
import { useRouter } from "@/i18n/navigation";
import { ApiError, apiFetch } from "@/lib/api/client";
import type { ManagedGroupDetail } from "@/lib/api/types";

const RETENTION_MIN_DAYS = 30;

/** IANA zones offered in the timezone control (the runtime's own DB). */
function supportedTimeZones(): string[] {
  const intl = Intl as typeof Intl & {
    supportedValuesOf?: (key: string) => string[];
  };
  if (typeof intl.supportedValuesOf === "function") {
    return intl.supportedValuesOf("timeZone");
  }
  return [];
}

export function GroupDetailPage() {
  const t = useTranslations("groupSettings");
  const tCommon = useTranslations("common");
  const router = useRouter();
  const params = useParams<{ groupId: string }>();
  const groupId = params.groupId;
  const { me } = useCustomerContext();

  const timeZones = useMemo(() => supportedTimeZones(), []);

  const [detail, setDetail] = useState<ManagedGroupDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Timezone edit
  const [tz, setTz] = useState("");
  const [tzSaving, setTzSaving] = useState(false);
  const [tzMessage, setTzMessage] = useState<string | null>(null);

  // Retention edit
  const [retentionInput, setRetentionInput] = useState("");
  const [unlimited, setUnlimited] = useState(false);
  const [retentionSaving, setRetentionSaving] = useState(false);
  const [retentionError, setRetentionError] = useState<string | null>(null);
  const [retentionMessage, setRetentionMessage] = useState<string | null>(null);

  // Delete / retry
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);

  const applyDetail = useCallback((d: ManagedGroupDetail) => {
    setDetail(d);
    setTz(d.tz);
    if (d.groupPolicyDays === null) {
      setUnlimited(true);
      setRetentionInput("");
    } else {
      setUnlimited(false);
      setRetentionInput(String(d.groupPolicyDays));
    }
  }, []);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await apiFetch<ManagedGroupDetail>(`/api/groups/${groupId}`);
      applyDetail(data);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        window.location.href = "/api/auth/sign-in";
        return;
      }
      if (err instanceof ApiError && err.status === 403) {
        setError(tCommon("forbidden"));
        return;
      }
      if (err instanceof ApiError && err.status === 404) {
        setError(t("notFound"));
        return;
      }
      setError(t("detailError"));
    } finally {
      setLoading(false);
    }
  }, [groupId, applyDetail, t, tCommon]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const isOwner = me?.accountId != null && me.accountId === detail?.ownerId;

  async function saveTimezone() {
    setTzSaving(true);
    setTzMessage(null);
    try {
      await apiFetch(`/api/groups/${groupId}/timezone`, {
        method: "PUT",
        body: JSON.stringify({ tz }),
      });
      setTzMessage(t("timezoneSaved"));
      await reload();
    } catch {
      setTzMessage(t("timezoneSaveError"));
    } finally {
      setTzSaving(false);
    }
  }

  async function saveRetention(e: React.FormEvent) {
    e.preventDefault();
    setRetentionError(null);
    setRetentionMessage(null);
    let groupPolicyDays: number | null;
    if (unlimited) {
      groupPolicyDays = null;
    } else {
      const parsed = Number.parseInt(retentionInput, 10);
      if (!Number.isInteger(parsed)) {
        setRetentionError(t("retentionParseError"));
        return;
      }
      if (parsed < RETENTION_MIN_DAYS) {
        setRetentionError(t("retentionTooShort", { min: RETENTION_MIN_DAYS }));
        return;
      }
      groupPolicyDays = parsed;
    }
    setRetentionSaving(true);
    try {
      await apiFetch(`/api/groups/${groupId}/retention`, {
        method: "PUT",
        body: JSON.stringify({ groupPolicyDays }),
      });
      setRetentionMessage(t("retentionSaved"));
      await reload();
    } catch (err) {
      const code = err instanceof Error ? err.message : "";
      setRetentionError(
        code === "retention_too_short"
          ? t("retentionTooShort", { min: RETENTION_MIN_DAYS })
          : t("retentionSaveError"),
      );
    } finally {
      setRetentionSaving(false);
    }
  }

  async function handleDelete() {
    setDeleting(true);
    setActionError(null);
    try {
      await apiFetch(`/api/groups/${groupId}`, { method: "DELETE" });
      router.push("/settings/groups");
    } catch {
      setActionError(t("deleteError"));
      setDeleting(false);
      setConfirmDelete(false);
    }
  }

  async function handleRetry() {
    setRetrying(true);
    setActionError(null);
    try {
      await apiFetch(`/api/groups/${groupId}/retry-provision`, {
        method: "POST",
      });
      await reload();
    } catch {
      setActionError(t("retryError"));
    } finally {
      setRetrying(false);
    }
  }

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-sm text-muted-foreground">{tCommon("loading")}</p>
      </div>
    );
  }

  if (error || !detail) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-sm text-destructive">{error ?? t("detailError")}</p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl space-y-10 px-4 py-8 sm:px-6">
      <header>
        <Button
          variant="ghost"
          size="sm"
          className="mb-2 px-0"
          onClick={() => router.push("/settings/groups")}
        >
          ← {t("backToList")}
        </Button>
        <div className="flex items-center gap-2">
          <h1 className="text-2xl font-bold text-foreground">{detail.name}</h1>
          {isOwner && <Badge variant="outline">{t("ownerBadge")}</Badge>}
        </div>
        {detail.description && (
          <p className="mt-1 text-sm text-muted-foreground">
            {detail.description}
          </p>
        )}
      </header>

      {/* Members (read-only — membership is immutable) */}
      <section className="space-y-3">
        <h2 className="text-lg font-semibold text-foreground">
          {t("membersTitle")}
        </h2>
        <p className="text-sm text-muted-foreground">{t("membersImmutable")}</p>
        <ul className="divide-y divide-border rounded-md border border-border">
          {detail.members.map((m) => (
            <li key={m.id} className="px-4 py-2 text-sm text-foreground">
              {m.name}
            </li>
          ))}
        </ul>
      </section>

      {/* Timezone */}
      <section className="space-y-3">
        <header>
          <h2 className="text-lg font-semibold text-foreground">
            {t("timezoneTitle")}
          </h2>
          <p className="text-sm text-muted-foreground">
            {t("timezoneEditDescription")}
          </p>
        </header>
        <Select
          id="group-detail-tz"
          value={tz}
          onChange={(e) => {
            setTz(e.target.value);
            setTzMessage(null);
          }}
          aria-label={t("timezoneTitle")}
        >
          {timeZones.map((zone) => (
            <option key={zone} value={zone}>
              {zone}
            </option>
          ))}
        </Select>
        <div className="flex items-center gap-3">
          <Button
            type="button"
            onClick={saveTimezone}
            disabled={tzSaving || tz === detail.tz}
          >
            {tCommon("save")}
          </Button>
          {tzMessage && (
            <span className="text-sm text-muted-foreground">{tzMessage}</span>
          )}
        </div>
      </section>

      {/* Retention */}
      <section className="space-y-3">
        <header>
          <h2 className="text-lg font-semibold text-foreground">
            {t("retentionTitle")}
          </h2>
          <p className="text-sm text-muted-foreground">
            {t("retentionDescription")}
          </p>
        </header>
        <form className="space-y-3" onSubmit={saveRetention}>
          <div className="flex items-center gap-3">
            <Input
              id="group-retention-days"
              type="number"
              min={RETENTION_MIN_DAYS}
              value={retentionInput}
              onChange={(e) => setRetentionInput(e.target.value)}
              disabled={retentionSaving || unlimited}
              aria-label={t("retentionDaysLabel")}
              className="flex-1"
            />
            <label className="flex items-center gap-2 text-sm text-foreground">
              <input
                type="checkbox"
                checked={unlimited}
                onChange={(e) => setUnlimited(e.target.checked)}
                disabled={retentionSaving}
                aria-label={t("retentionUnlimitedLabel")}
              />
              {t("retentionUnlimitedLabel")}
            </label>
          </div>
          {retentionError && (
            <p className="text-sm text-destructive">{retentionError}</p>
          )}
          <div className="flex items-center gap-3">
            <Button type="submit" disabled={retentionSaving}>
              {tCommon("save")}
            </Button>
            {retentionMessage && (
              <span className="text-sm text-muted-foreground">
                {retentionMessage}
              </span>
            )}
          </div>
        </form>
      </section>

      {/* Provisioning / owner actions */}
      <section className="space-y-3 rounded-md border border-destructive/30 p-4">
        <header>
          <h2 className="text-lg font-semibold text-foreground">
            {t("dangerTitle")}
          </h2>
          <p className="text-sm text-muted-foreground">
            {isOwner ? t("dangerDescription") : t("ownerOnlyHint")}
          </p>
        </header>

        <div className="flex items-center gap-2 text-sm">
          <span className="text-muted-foreground">{t("dbStatusLabel")}</span>
          <Badge
            variant={
              detail.databaseStatus === "active"
                ? "secondary"
                : detail.databaseStatus === "failed"
                  ? "destructive"
                  : "warning"
            }
          >
            {detail.databaseStatus === "active" ||
            detail.databaseStatus === "failed" ||
            detail.databaseStatus === "provisioning"
              ? t(`dbStatus.${detail.databaseStatus}`)
              : detail.databaseStatus}
          </Badge>
        </div>

        {actionError && (
          <p className="text-sm text-destructive">{actionError}</p>
        )}

        {isOwner && detail.databaseStatus === "failed" && (
          <Button
            type="button"
            variant="outline"
            onClick={handleRetry}
            disabled={retrying}
          >
            {t("retryProvision")}
          </Button>
        )}

        {isOwner &&
          (confirmDelete ? (
            <div
              role="alertdialog"
              aria-label={t("deleteTitle")}
              className="rounded-md border border-border bg-card p-4 text-sm"
            >
              <p className="font-medium text-foreground">{t("deleteTitle")}</p>
              <p className="mt-1 text-muted-foreground">{t("deleteConfirm")}</p>
              <div className="mt-3 flex gap-2">
                <Button
                  variant="destructive"
                  onClick={handleDelete}
                  disabled={deleting}
                >
                  {tCommon("delete")}
                </Button>
                <Button
                  variant="ghost"
                  onClick={() => setConfirmDelete(false)}
                  disabled={deleting}
                >
                  {tCommon("cancel")}
                </Button>
              </div>
            </div>
          ) : (
            <Button
              type="button"
              variant="destructive"
              onClick={() => setConfirmDelete(true)}
            >
              {t("deleteButton")}
            </Button>
          ))}
      </section>
    </div>
  );
}
