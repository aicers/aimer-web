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

export function TiFeedsPage() {
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

  const [toast, setToast] = useState<{
    message: string;
    type: "success" | "error";
  } | null>(null);

  const showToast = useCallback(
    (message: string, type: "success" | "error") => {
      setToast({ message, type });
      setTimeout(() => setToast(null), 4000);
    },
    [],
  );

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
      {toast && (
        <div
          className={`rounded-lg border px-4 py-3 text-sm ${
            toast.type === "success"
              ? "border-border bg-muted/50 text-foreground"
              : "border-destructive/50 bg-destructive/10 text-destructive"
          }`}
        >
          {toast.message}
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
