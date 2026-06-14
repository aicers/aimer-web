"use client";

import { useTranslations } from "next-intl";
import { useCallback, useEffect, useRef, useState } from "react";

import { Timestamp } from "@/components/timestamp";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { adminFetch } from "@/lib/api/admin-client";
import { ApiError } from "@/lib/api/client";

interface FeedSourceStatus {
  sourcePolicyId: string;
  label: string;
  present: boolean;
  rowCount: number;
  sourceUpdatedAt: string | null;
  feedHash: string | null;
  stale: boolean;
}

interface SelfFetchSourceStatus {
  sourcePolicyId: string;
  label: string;
  fetchable: boolean;
  unavailableReason: "merged" | "fixture-only" | null;
  fetchUrl: string | null;
  authKeyRequired: boolean;
  authKeyName: string | null;
  authKeySet: boolean;
  present: boolean;
  stale: boolean;
  rowCount: number;
  lastFetchedAt: string | null;
  lastAttemptAt: string | null;
  lastStatus: string | null;
  lastError: string | null;
  lastRowCount: number | null;
  effectiveCadenceMs?: number | null;
  nextFetchDueAt?: string | null;
  dueNow?: boolean;
}

interface SelfFetchSchedule {
  enabled: boolean;
  intervalMs?: number;
}

type Toast = { message: string; type: "success" | "error" } | null;

export function TiFeedsPage({ selfFetch = false }: { selfFetch?: boolean }) {
  return selfFetch ? <SelfFetchView /> : <ManualUploadView />;
}

// ---------------------------------------------------------------------------
// Shared toast helper
// ---------------------------------------------------------------------------

function useToast() {
  const [toast, setToast] = useState<Toast>(null);
  const showToast = useCallback(
    (message: string, type: "success" | "error") => {
      setToast({ message, type });
      setTimeout(() => setToast(null), 4000);
    },
    [],
  );
  return { toast, showToast };
}

function ToastBanner({ toast }: { toast: Toast }) {
  if (!toast) return null;
  return (
    <div
      className={`rounded-lg border px-4 py-3 text-sm ${
        toast.type === "success"
          ? "border-border bg-muted/50 text-foreground"
          : "border-destructive/50 bg-destructive/10 text-destructive"
      }`}
    >
      {toast.message}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Manual-upload view (unchanged behavior from #566)
// ---------------------------------------------------------------------------

function ManualUploadView() {
  const t = useTranslations("adminTiFeeds");
  const tCommon = useTranslations("common");

  const [sources, setSources] = useState<FeedSourceStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [uploadTarget, setUploadTarget] = useState<FeedSourceStatus | null>(
    null,
  );
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [uploadLoading, setUploadLoading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const { toast, showToast } = useToast();

  const fetchStatus = useCallback(async () => {
    try {
      const data = await adminFetch<{ sources: FeedSourceStatus[] }>(
        "/api/admin/ti-feed",
      );
      setSources(data.sources);
      setError(null);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        window.location.href = "/api/admin-auth/sign-in";
        return;
      }
      setError(t("errorLoading"));
    }
  }, [t]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    (async () => {
      await fetchStatus();
      if (!cancelled) setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [fetchStatus]);

  const openUploadDialog = (source: FeedSourceStatus) => {
    setUploadTarget(source);
    setUploadFile(null);
  };

  const closeUploadDialog = (open: boolean) => {
    if (!open) {
      setUploadTarget(null);
      setUploadFile(null);
    }
  };

  const handleUpload = async () => {
    if (!uploadTarget || !uploadFile) return;

    setUploadLoading(true);
    try {
      const form = new FormData();
      form.append("sourcePolicyId", uploadTarget.sourcePolicyId);
      form.append("file", uploadFile);

      const result = await adminFetch<{ rowCount: number; feedHash: string }>(
        "/api/admin/ti-feed/upload",
        { method: "POST", body: form },
      );

      setUploadTarget(null);
      setUploadFile(null);
      showToast(t("uploadSuccess", { count: result.rowCount }), "success");
      await fetchStatus();
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        window.location.href = "/api/admin-auth/sign-in";
        return;
      }
      showToast(
        err instanceof ApiError ? err.message : t("uploadError"),
        "error",
      );
    } finally {
      setUploadLoading(false);
    }
  };

  return (
    <div className="space-y-6">
      <ToastBanner toast={toast} />

      {loading && (
        <div className="flex items-center justify-center py-12">
          <p className="text-sm text-muted-foreground">{tCommon("loading")}</p>
        </div>
      )}

      {error && !loading && (
        <div className="flex items-center justify-center py-12">
          <p className="text-sm text-destructive">{error}</p>
        </div>
      )}

      {!loading && !error && (
        <div className="rounded-md border border-border bg-card">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("source")}</TableHead>
                <TableHead>{t("rowCount")}</TableHead>
                <TableHead>{t("lastUpdated")}</TableHead>
                <TableHead>{t("freshness")}</TableHead>
                <TableHead>{t("actions")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sources.map((source) => (
                <TableRow key={source.sourcePolicyId}>
                  <TableCell>
                    <span className="font-medium">{source.label}</span>
                    <p className="text-xs text-muted-foreground">
                      {source.sourcePolicyId}
                    </p>
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {source.rowCount}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {source.sourceUpdatedAt ? (
                      <Timestamp at={source.sourceUpdatedAt} />
                    ) : (
                      t("never")
                    )}
                  </TableCell>
                  <TableCell>
                    {!source.present ? (
                      <Badge variant="secondary">{t("notUploaded")}</Badge>
                    ) : source.stale ? (
                      <Badge variant="destructive">{t("stale")}</Badge>
                    ) : (
                      <Badge variant="default">{t("fresh")}</Badge>
                    )}
                  </TableCell>
                  <TableCell>
                    <Button
                      type="button"
                      size="sm"
                      onClick={() => openUploadDialog(source)}
                    >
                      {t("upload")}
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <Dialog open={uploadTarget !== null} onOpenChange={closeUploadDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("uploadTitle")}</DialogTitle>
            <DialogDescription>
              {t("uploadDescription", { source: uploadTarget?.label ?? "" })}
            </DialogDescription>
          </DialogHeader>
          <div className="py-4">
            <input
              ref={fileInputRef}
              type="file"
              aria-label={t("selectFile")}
              onChange={(e) => setUploadFile(e.target.files?.[0] ?? null)}
              className="block w-full text-sm text-foreground file:mr-4 file:rounded-md file:border-0 file:bg-muted file:px-4 file:py-2 file:text-sm file:font-medium file:text-foreground hover:file:bg-accent"
            />
          </div>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline" disabled={uploadLoading}>
                {tCommon("cancel")}
              </Button>
            </DialogClose>
            <Button
              type="button"
              disabled={uploadLoading || !uploadFile}
              onClick={handleUpload}
            >
              {uploadLoading ? tCommon("loading") : t("upload")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Self-fetch view (#568)
// ---------------------------------------------------------------------------

function SelfFetchView() {
  const t = useTranslations("adminTiFeeds");
  const tCommon = useTranslations("common");

  const [sources, setSources] = useState<SelfFetchSourceStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [fetching, setFetching] = useState<string | null>(null);

  const [authKeyOpen, setAuthKeyOpen] = useState(false);
  const [authKeyValue, setAuthKeyValue] = useState("");
  const [authKeySaving, setAuthKeySaving] = useState(false);

  // Schedule form state. `scheduleEnabled` / `intervalMinutes` are the edited
  // (draft) values; `fetchStatus` seeds them from the stored schedule on each
  // load. `savedScheduleEnabled` mirrors the PERSISTED `enabled` flag and only
  // changes on a successful load/save — the table's next-due column and the
  // status text are driven from it so a not-yet-saved toggle never implies the
  // worker's behavior has changed.
  const [scheduleEnabled, setScheduleEnabled] = useState(false);
  const [savedScheduleEnabled, setSavedScheduleEnabled] = useState(false);
  const [intervalMinutes, setIntervalMinutes] = useState("");
  const [scheduleSaving, setScheduleSaving] = useState(false);

  const { toast, showToast } = useToast();

  const fetchStatus = useCallback(async () => {
    try {
      const data = await adminFetch<{
        sources: SelfFetchSourceStatus[];
        schedule: SelfFetchSchedule;
      }>("/api/admin/ti-feed");
      setSources(data.sources);
      setScheduleEnabled(data.schedule.enabled);
      setSavedScheduleEnabled(data.schedule.enabled);
      setIntervalMinutes(
        data.schedule.intervalMs
          ? String(Math.round(data.schedule.intervalMs / 60000))
          : "",
      );
      setError(null);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        window.location.href = "/api/admin-auth/sign-in";
        return;
      }
      setError(t("errorLoading"));
    }
  }, [t]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    (async () => {
      await fetchStatus();
      if (!cancelled) setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [fetchStatus]);

  const urlhausKeySet = sources.some(
    (s) => s.authKeyName === "urlhaus" && s.authKeySet,
  );

  const handleFetch = async (source: SelfFetchSourceStatus) => {
    setFetching(source.sourcePolicyId);
    try {
      const result = await adminFetch<{
        status: "imported" | "not-modified" | "too-soon" | "error";
        rowCount?: number;
        nextAllowedAt?: string;
        error?: string;
      }>("/api/admin/ti-feed/fetch", {
        method: "POST",
        body: JSON.stringify({ sourcePolicyId: source.sourcePolicyId }),
      });
      if (result.status === "imported") {
        showToast(
          t("fetchImported", { count: result.rowCount ?? 0 }),
          "success",
        );
      } else if (result.status === "not-modified") {
        showToast(t("fetchNotModified"), "success");
      } else if (result.status === "too-soon") {
        showToast(t("fetchTooSoon"), "error");
      } else {
        showToast(result.error ?? t("fetchError"), "error");
      }
      await fetchStatus();
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        window.location.href = "/api/admin-auth/sign-in";
        return;
      }
      showToast(
        err instanceof ApiError ? err.message : t("fetchError"),
        "error",
      );
    } finally {
      setFetching(null);
    }
  };

  const handleSaveAuthKey = async () => {
    if (authKeyValue.length === 0) return;
    setAuthKeySaving(true);
    try {
      await adminFetch("/api/admin/ti-feed/auth-key", {
        method: "PUT",
        body: JSON.stringify({ keyName: "urlhaus", authKey: authKeyValue }),
      });
      setAuthKeyOpen(false);
      setAuthKeyValue("");
      showToast(t("authKeySaved"), "success");
      await fetchStatus();
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        window.location.href = "/api/admin-auth/sign-in";
        return;
      }
      showToast(
        err instanceof ApiError ? err.message : t("authKeyError"),
        "error",
      );
    } finally {
      setAuthKeySaving(false);
    }
  };

  const handleSaveSchedule = async () => {
    const trimmed = intervalMinutes.trim();
    let intervalMs: number | undefined;
    if (trimmed.length > 0) {
      const minutes = Number(trimmed);
      if (!Number.isFinite(minutes) || minutes <= 0) {
        showToast(t("scheduleIntervalInvalid"), "error");
        return;
      }
      intervalMs = Math.round(minutes * 60000);
    }
    setScheduleSaving(true);
    try {
      await adminFetch("/api/admin/ti-feed/schedule", {
        method: "PUT",
        body: JSON.stringify({ enabled: scheduleEnabled, intervalMs }),
      });
      showToast(t("scheduleSaved"), "success");
      await fetchStatus();
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        window.location.href = "/api/admin-auth/sign-in";
        return;
      }
      showToast(
        err instanceof ApiError ? err.message : t("scheduleError"),
        "error",
      );
    } finally {
      setScheduleSaving(false);
    }
  };

  return (
    <div className="space-y-6">
      <ToastBanner toast={toast} />

      {!loading && !error && (
        <div className="space-y-4 rounded-md border border-border bg-card px-4 py-4">
          <div>
            <p className="text-sm font-medium text-foreground">
              {t("scheduleTitle")}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              {t("scheduleDescription")}
            </p>
          </div>
          <label className="flex items-center gap-2 text-sm text-foreground">
            <input
              type="checkbox"
              checked={scheduleEnabled}
              onChange={(e) => setScheduleEnabled(e.target.checked)}
              className="h-4 w-4 rounded border-border"
            />
            {t("scheduleEnableLabel")}
          </label>
          <div className="space-y-1">
            <label
              htmlFor="self-fetch-interval"
              className="block text-xs font-medium text-muted-foreground"
            >
              {t("scheduleIntervalLabel")}
            </label>
            <Input
              id="self-fetch-interval"
              type="number"
              min={1}
              inputMode="numeric"
              value={intervalMinutes}
              onChange={(e) => setIntervalMinutes(e.target.value)}
              className="max-w-[12rem]"
            />
            <p className="text-xs text-muted-foreground">
              {t("scheduleIntervalHint")}
            </p>
          </div>
          <div className="flex items-center justify-between">
            <p className="text-xs text-muted-foreground">
              {savedScheduleEnabled
                ? t("scheduleEnabledOn")
                : t("scheduleEnabledOff")}
            </p>
            <Button
              type="button"
              size="sm"
              disabled={scheduleSaving}
              onClick={handleSaveSchedule}
            >
              {scheduleSaving ? tCommon("loading") : t("scheduleSave")}
            </Button>
          </div>
        </div>
      )}

      {!loading && !error && (
        <div className="flex items-center justify-between rounded-md border border-border bg-card px-4 py-3">
          <div>
            <p className="text-sm font-medium text-foreground">
              {t("authKeyTitle")}
            </p>
            <p className="text-xs text-muted-foreground">
              {urlhausKeySet ? t("authKeySet") : t("authKeyUnset")}
            </p>
          </div>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => setAuthKeyOpen(true)}
          >
            {urlhausKeySet ? t("authKeyReplace") : t("authKeySetButton")}
          </Button>
        </div>
      )}

      {loading && (
        <div className="flex items-center justify-center py-12">
          <p className="text-sm text-muted-foreground">{tCommon("loading")}</p>
        </div>
      )}

      {error && !loading && (
        <div className="flex items-center justify-center py-12">
          <p className="text-sm text-destructive">{error}</p>
        </div>
      )}

      {!loading && !error && (
        <div className="rounded-md border border-border bg-card">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("source")}</TableHead>
                <TableHead>{t("fetchUrl")}</TableHead>
                <TableHead>{t("lastFetched")}</TableHead>
                <TableHead>{t("nextFetch")}</TableHead>
                <TableHead>{t("status")}</TableHead>
                <TableHead>{t("freshness")}</TableHead>
                <TableHead>{t("actions")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sources.map((source) => (
                <TableRow key={source.sourcePolicyId}>
                  <TableCell>
                    <span className="font-medium">{source.label}</span>
                    <p className="text-xs text-muted-foreground">
                      {source.sourcePolicyId}
                    </p>
                  </TableCell>
                  <TableCell className="max-w-xs break-all text-xs text-muted-foreground">
                    {source.fetchable ? source.fetchUrl : t("notFetchable")}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {source.lastFetchedAt ? (
                      <Timestamp at={source.lastFetchedAt} />
                    ) : (
                      t("never")
                    )}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {!source.fetchable ? (
                      "—"
                    ) : !savedScheduleEnabled ? (
                      t("scheduleDisabledNextFetch")
                    ) : source.dueNow ? (
                      t("scheduleDueNow")
                    ) : source.nextFetchDueAt ? (
                      <Timestamp at={source.nextFetchDueAt} />
                    ) : (
                      "—"
                    )}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {source.lastStatus ? (
                      <span title={source.lastError ?? undefined}>
                        {source.lastStatus}
                      </span>
                    ) : (
                      "—"
                    )}
                  </TableCell>
                  <TableCell>
                    {!source.fetchable ? (
                      <Badge variant="secondary">
                        {source.unavailableReason === "merged"
                          ? t("merged")
                          : t("fixtureOnly")}
                      </Badge>
                    ) : !source.present ? (
                      <Badge variant="secondary">{t("notFetched")}</Badge>
                    ) : source.stale ? (
                      <Badge variant="destructive">{t("stale")}</Badge>
                    ) : (
                      <Badge variant="default">{t("fresh")}</Badge>
                    )}
                  </TableCell>
                  <TableCell>
                    {source.fetchable && (
                      <Button
                        type="button"
                        size="sm"
                        disabled={fetching !== null}
                        onClick={() => handleFetch(source)}
                      >
                        {fetching === source.sourcePolicyId
                          ? tCommon("loading")
                          : t("fetchNow")}
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <Dialog
        open={authKeyOpen}
        onOpenChange={(open) => {
          if (!open) {
            setAuthKeyOpen(false);
            setAuthKeyValue("");
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("authKeyTitle")}</DialogTitle>
            <DialogDescription>{t("authKeyDescription")}</DialogDescription>
          </DialogHeader>
          <div className="py-4">
            <input
              type="password"
              aria-label={t("authKeyTitle")}
              value={authKeyValue}
              onChange={(e) => setAuthKeyValue(e.target.value)}
              placeholder={t("authKeyPlaceholder")}
              className="block w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground"
            />
          </div>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline" disabled={authKeySaving}>
                {tCommon("cancel")}
              </Button>
            </DialogClose>
            <Button
              type="button"
              disabled={authKeySaving || authKeyValue.length === 0}
              onClick={handleSaveAuthKey}
            >
              {authKeySaving ? tCommon("loading") : tCommon("save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
