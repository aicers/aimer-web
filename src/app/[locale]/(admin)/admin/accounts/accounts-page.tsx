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

interface Account {
  id: string;
  username: string;
  displayName: string | null;
  email: string | null;
  status: string;
  lastSignInAt: string | null;
  adminEligible: boolean;
  analystEligible: boolean;
  createdAt: string;
}

const DATE_TIME_FORMAT = {
  year: "numeric" as const,
  month: "2-digit" as const,
  day: "2-digit" as const,
  hour: "2-digit" as const,
  minute: "2-digit" as const,
};

export function AccountsPage() {
  const t = useTranslations("adminAccounts");
  const tCommon = useTranslations("common");
  const format = useFormatter();

  const [accounts, setAccounts] = useState<Account[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [currentAccountId, setCurrentAccountId] = useState<string | null>(null);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [dialogTarget, setDialogTarget] = useState<Account | null>(null);
  const [dialogAction, setDialogAction] = useState<
    "suspend" | "unsuspend" | null
  >(null);
  const [actionLoading, setActionLoading] = useState(false);

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

  const fetchAccounts = useCallback(async () => {
    try {
      const data = await adminFetch<{ accounts: Account[] }>(
        "/api/admin/accounts",
      );
      setAccounts(data.accounts);
      setError(null);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        window.location.href = "/api/admin-auth/sign-in";
        return;
      }
      setError(t("errorLoading"));
    }
  }, [t]);

  const fetchCurrentAccount = useCallback(async () => {
    try {
      const data = await apiFetch<{ accountId: string }>("/api/admin-auth/me");
      setCurrentAccountId(data.accountId);
    } catch {
      // Not critical — worst case we show actions for own row
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    (async () => {
      await Promise.all([fetchAccounts(), fetchCurrentAccount()]);
      if (!cancelled) setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [fetchAccounts, fetchCurrentAccount]);

  const openDialog = (account: Account, action: "suspend" | "unsuspend") => {
    setDialogTarget(account);
    setDialogAction(action);
    setDialogOpen(true);
  };

  const handleConfirm = async () => {
    if (!dialogTarget || !dialogAction) return;

    setActionLoading(true);
    try {
      const newStatus = dialogAction === "suspend" ? "suspended" : "active";
      await adminFetch(`/api/admin/accounts/${dialogTarget.id}`, {
        method: "PATCH",
        body: JSON.stringify({ status: newStatus }),
      });

      setDialogOpen(false);
      showToast(t("actionSuccess"), "success");
      await fetchAccounts();
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        window.location.href = "/api/admin-auth/sign-in";
        return;
      }
      showToast(t("actionError"), "error");
    } finally {
      setActionLoading(false);
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

      {/* Table */}
      {!loading &&
        !error &&
        (accounts.length === 0 ? (
          <div className="flex items-center justify-center py-12">
            <p className="text-sm text-muted-foreground">{t("noResults")}</p>
          </div>
        ) : (
          <div className="rounded-lg border border-border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("displayName")}</TableHead>
                  <TableHead>{t("email")}</TableHead>
                  <TableHead>{t("status")}</TableHead>
                  <TableHead>{t("adminEligible")}</TableHead>
                  <TableHead>{t("analystEligible")}</TableHead>
                  <TableHead>{t("lastSignIn")}</TableHead>
                  <TableHead>{t("actions")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {accounts.map((account) => {
                  const isSelf = account.id === currentAccountId;
                  return (
                    <TableRow key={account.id}>
                      <TableCell>
                        <div>
                          <span className="font-medium">
                            {account.displayName || account.username}
                          </span>
                          {isSelf && (
                            <span className="ml-1 text-muted-foreground">
                              {t("you")}
                            </span>
                          )}
                          {account.displayName &&
                            account.displayName !== account.username && (
                              <p className="text-xs text-muted-foreground">
                                {account.username}
                              </p>
                            )}
                        </div>
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {account.email ?? "—"}
                      </TableCell>
                      <TableCell>
                        <Badge variant={statusVariant(account.status)}>
                          {t(
                            account.status as
                              | "active"
                              | "suspended"
                              | "disabled",
                          )}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {account.adminEligible
                          ? t("eligible")
                          : t("notEligible")}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {account.analystEligible
                          ? t("eligible")
                          : t("notEligible")}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {account.lastSignInAt
                          ? format.dateTime(
                              new Date(account.lastSignInAt),
                              DATE_TIME_FORMAT,
                            )
                          : t("never")}
                      </TableCell>
                      <TableCell>
                        {!isSelf && account.status === "active" && (
                          <Button
                            type="button"
                            variant="destructive"
                            size="sm"
                            onClick={() => openDialog(account, "suspend")}
                          >
                            {t("suspend")}
                          </Button>
                        )}
                        {!isSelf && account.status === "suspended" && (
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={() => openDialog(account, "unsuspend")}
                          >
                            {t("unsuspend")}
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        ))}

      {/* Confirmation dialog */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {dialogAction === "suspend"
                ? t("suspendTitle")
                : t("unsuspendTitle")}
            </DialogTitle>
            <DialogDescription>
              {dialogAction === "suspend"
                ? t("suspendConfirm", {
                    name:
                      dialogTarget?.displayName || dialogTarget?.username || "",
                  })
                : t("unsuspendConfirm", {
                    name:
                      dialogTarget?.displayName || dialogTarget?.username || "",
                  })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline" disabled={actionLoading}>
                {tCommon("cancel")}
              </Button>
            </DialogClose>
            <Button
              type="button"
              variant={dialogAction === "suspend" ? "destructive" : "default"}
              disabled={actionLoading}
              onClick={handleConfirm}
            >
              {actionLoading
                ? tCommon("loading")
                : dialogAction === "suspend"
                  ? t("suspend")
                  : t("unsuspend")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
