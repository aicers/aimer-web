"use client";

import { useFormatter, useTranslations } from "next-intl";
import { useCallback, useEffect, useState } from "react";

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
import { Select } from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { adminFetch } from "@/lib/api/admin-client";
import { ApiError, apiFetch } from "@/lib/api/client";

interface Admin {
  id: string;
  username: string;
  displayName: string | null;
  email: string | null;
  status: string;
  lastSignInAt: string | null;
  createdAt: string;
}

interface Account {
  id: string;
  username: string;
  displayName: string | null;
  email: string | null;
  status: string;
  adminEligible: boolean;
}

const DATE_TIME_FORMAT = {
  year: "numeric" as const,
  month: "2-digit" as const,
  day: "2-digit" as const,
  hour: "2-digit" as const,
  minute: "2-digit" as const,
};

export function AdminsPage() {
  const t = useTranslations("adminAdmins");
  const tCommon = useTranslations("common");
  const format = useFormatter();

  const [admins, setAdmins] = useState<Admin[]>([]);
  const [maxAdmins, setMaxAdmins] = useState(3);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [currentAccountId, setCurrentAccountId] = useState<string | null>(null);

  // All accounts (for designation dialog)
  const [accounts, setAccounts] = useState<Account[]>([]);

  // Designate dialog
  const [designateOpen, setDesignateOpen] = useState(false);
  const [selectedAccountId, setSelectedAccountId] = useState<string>("");
  const [designateLoading, setDesignateLoading] = useState(false);

  // Revoke dialog
  const [revokeOpen, setRevokeOpen] = useState(false);
  const [revokeTarget, setRevokeTarget] = useState<Admin | null>(null);
  const [revokeLoading, setRevokeLoading] = useState(false);

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

  const fetchAdmins = useCallback(async () => {
    try {
      const data = await adminFetch<{
        admins: Admin[];
        maxAdmins: number;
      }>("/api/admin/admins");
      setAdmins(data.admins);
      setMaxAdmins(data.maxAdmins);
      setError(null);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        window.location.href = "/api/admin-auth/sign-in";
        return;
      }
      setError(t("errorLoading"));
    }
  }, [t]);

  const fetchAccounts = useCallback(async () => {
    try {
      const data = await adminFetch<{ accounts: Account[] }>(
        "/api/admin/accounts",
      );
      setAccounts(data.accounts);
    } catch {
      // Not critical for initial load
    }
  }, []);

  const fetchCurrentAccount = useCallback(async () => {
    try {
      const data = await apiFetch<{ accountId: string }>("/api/admin-auth/me");
      setCurrentAccountId(data.accountId);
    } catch {
      // Not critical
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    (async () => {
      await Promise.all([
        fetchAdmins(),
        fetchAccounts(),
        fetchCurrentAccount(),
      ]);
      if (!cancelled) setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [fetchAdmins, fetchAccounts, fetchCurrentAccount]);

  // Accounts eligible for designation (active, not already admin)
  const adminIds = new Set(admins.map((a) => a.id));
  const eligibleAccounts = accounts.filter(
    (a) => a.status === "active" && !a.adminEligible && !adminIds.has(a.id),
  );

  const canDesignate = admins.length < maxAdmins && eligibleAccounts.length > 0;

  const handleDesignate = async () => {
    if (!selectedAccountId) return;

    setDesignateLoading(true);
    try {
      await adminFetch("/api/admin/admins", {
        method: "POST",
        body: JSON.stringify({ accountId: selectedAccountId }),
      });

      setDesignateOpen(false);
      setSelectedAccountId("");
      showToast(t("designateSuccess"), "success");
      await Promise.all([fetchAdmins(), fetchAccounts()]);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        window.location.href = "/api/admin-auth/sign-in";
        return;
      }
      if (err instanceof ApiError && err.status === 409) {
        showToast(
          err.message.includes("Maximum")
            ? t("maxReached", { max: maxAdmins })
            : t("alreadyAdmin"),
          "error",
        );
      } else {
        showToast(t("actionError"), "error");
      }
    } finally {
      setDesignateLoading(false);
    }
  };

  const openRevokeDialog = (admin: Admin) => {
    setRevokeTarget(admin);
    setRevokeOpen(true);
  };

  const handleRevoke = async () => {
    if (!revokeTarget) return;

    setRevokeLoading(true);
    try {
      await adminFetch(`/api/admin/admins/${revokeTarget.id}`, {
        method: "DELETE",
      });

      setRevokeOpen(false);
      showToast(t("revokeSuccess"), "success");
      await Promise.all([fetchAdmins(), fetchAccounts()]);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        window.location.href = "/api/admin-auth/sign-in";
        return;
      }
      showToast(t("actionError"), "error");
    } finally {
      setRevokeLoading(false);
    }
  };

  const statusVariant = (status: string) => {
    switch (status) {
      case "active":
        return "default" as const;
      case "suspended":
        return "destructive" as const;
      default:
        return "secondary" as const;
    }
  };

  return (
    <div className="space-y-6">
      {/* Toast */}
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

      {/* Loading */}
      {loading && (
        <div className="flex items-center justify-center py-12">
          <p className="text-sm text-muted-foreground">{tCommon("loading")}</p>
        </div>
      )}

      {/* Error */}
      {error && !loading && (
        <div className="flex items-center justify-center py-12">
          <p className="text-sm text-destructive">{error}</p>
        </div>
      )}

      {/* Content */}
      {!loading && !error && (
        <>
          {/* Header with count and designate button */}
          <div className="flex items-center justify-between">
            <p className="text-sm text-muted-foreground">
              {t("adminCount", { count: admins.length, max: maxAdmins })}
            </p>
            <Button
              type="button"
              onClick={() => setDesignateOpen(true)}
              disabled={!canDesignate}
            >
              {t("designate")}
            </Button>
          </div>

          {/* Table */}
          {admins.length === 0 ? (
            <div className="flex items-center justify-center py-12">
              <p className="text-sm text-muted-foreground">{t("noResults")}</p>
            </div>
          ) : (
            <div className="rounded-md border border-border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("displayName")}</TableHead>
                    <TableHead>{t("email")}</TableHead>
                    <TableHead>{t("status")}</TableHead>
                    <TableHead>{t("lastSignIn")}</TableHead>
                    <TableHead>{t("actions")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {admins.map((admin) => {
                    const isSelf = admin.id === currentAccountId;
                    return (
                      <TableRow key={admin.id}>
                        <TableCell>
                          <div>
                            <span className="font-medium">
                              {admin.displayName || admin.username}
                            </span>
                            {isSelf && (
                              <span className="ml-1 text-muted-foreground">
                                {t("you")}
                              </span>
                            )}
                            {admin.displayName &&
                              admin.displayName !== admin.username && (
                                <p className="text-xs text-muted-foreground">
                                  {admin.username}
                                </p>
                              )}
                          </div>
                        </TableCell>
                        <TableCell className="text-muted-foreground">
                          {admin.email ?? "—"}
                        </TableCell>
                        <TableCell>
                          <Badge variant={statusVariant(admin.status)}>
                            {t(
                              admin.status as
                                | "active"
                                | "suspended"
                                | "disabled",
                            )}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-muted-foreground">
                          {admin.lastSignInAt
                            ? format.dateTime(
                                new Date(admin.lastSignInAt),
                                DATE_TIME_FORMAT,
                              )
                            : t("never")}
                        </TableCell>
                        <TableCell>
                          {!isSelf && (
                            <Button
                              type="button"
                              variant="destructive"
                              size="sm"
                              onClick={() => openRevokeDialog(admin)}
                            >
                              {t("revoke")}
                            </Button>
                          )}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          )}
        </>
      )}

      {/* Designate dialog */}
      <Dialog open={designateOpen} onOpenChange={setDesignateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("designateTitle")}</DialogTitle>
            <DialogDescription>{t("designateDescription")}</DialogDescription>
          </DialogHeader>
          <div className="py-4">
            {eligibleAccounts.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                {t("noEligibleAccounts")}
              </p>
            ) : (
              <Select
                value={selectedAccountId}
                onChange={(e) => setSelectedAccountId(e.target.value)}
              >
                <option value="">{t("selectAccount")}</option>
                {eligibleAccounts.map((account) => (
                  <option key={account.id} value={account.id}>
                    {account.displayName || account.username}
                    {account.email ? ` (${account.email})` : ""}
                  </option>
                ))}
              </Select>
            )}
          </div>
          <DialogFooter>
            <DialogClose asChild>
              <Button
                type="button"
                variant="outline"
                disabled={designateLoading}
              >
                {tCommon("cancel")}
              </Button>
            </DialogClose>
            <Button
              type="button"
              disabled={
                designateLoading ||
                !selectedAccountId ||
                eligibleAccounts.length === 0
              }
              onClick={handleDesignate}
            >
              {designateLoading ? tCommon("loading") : t("designate")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Revoke confirmation dialog */}
      <Dialog open={revokeOpen} onOpenChange={setRevokeOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("revokeTitle")}</DialogTitle>
            <DialogDescription>
              {t("revokeConfirm", {
                name: revokeTarget?.displayName || revokeTarget?.username || "",
              })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline" disabled={revokeLoading}>
                {tCommon("cancel")}
              </Button>
            </DialogClose>
            <Button
              type="button"
              variant="destructive"
              disabled={revokeLoading}
              onClick={handleRevoke}
            >
              {revokeLoading ? tCommon("loading") : t("revoke")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
