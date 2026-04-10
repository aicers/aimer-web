"use client";

import { useTranslations } from "next-intl";
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
import { Input } from "@/components/ui/input";
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
import { ApiError } from "@/lib/api/client";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Customer {
  id: string;
  name: string;
  externalKey: string;
  description: string | null;
  status: string;
  databaseStatus: string;
  createdAt: string;
}

interface Account {
  id: string;
  username: string;
  displayName: string | null;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function CustomersPage() {
  const t = useTranslations("adminCustomers");
  const tCommon = useTranslations("common");

  const [customers, setCustomers] = useState<Customer[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Create dialog
  const [createOpen, setCreateOpen] = useState(false);
  const [createLoading, setCreateLoading] = useState(false);
  const [createName, setCreateName] = useState("");
  const [createExternalKey, setCreateExternalKey] = useState("");
  const [createDescription, setCreateDescription] = useState("");
  const [createManagerId, setCreateManagerId] = useState("");

  // Delete dialog
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Customer | null>(null);
  const [deleteLoading, setDeleteLoading] = useState(false);

  // Retry dialog
  const [retryOpen, setRetryOpen] = useState(false);
  const [retryTarget, setRetryTarget] = useState<Customer | null>(null);
  const [retryLoading, setRetryLoading] = useState(false);

  // Toast
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

  // -----------------------------------------------------------------------
  // Data fetching
  // -----------------------------------------------------------------------

  const fetchCustomers = useCallback(async () => {
    try {
      const data = await adminFetch<{ customers: Customer[] }>(
        "/api/admin/customers",
      );
      setCustomers(data.customers);
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
      const data = await adminFetch<{
        accounts: Account[];
      }>("/api/admin/accounts");
      setAccounts(data.accounts);
    } catch {
      // Non-critical — form will show empty select
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    (async () => {
      await Promise.all([fetchCustomers(), fetchAccounts()]);
      if (!cancelled) setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [fetchCustomers, fetchAccounts]);

  // -----------------------------------------------------------------------
  // Create
  // -----------------------------------------------------------------------

  const openCreate = () => {
    setCreateName("");
    setCreateExternalKey("");
    setCreateDescription("");
    setCreateManagerId("");
    setCreateOpen(true);
  };

  const handleCreate = async () => {
    setCreateLoading(true);
    try {
      await adminFetch("/api/admin/customers", {
        method: "POST",
        body: JSON.stringify({
          name: createName,
          externalKey: createExternalKey,
          description: createDescription || undefined,
          managerAccountId: createManagerId,
        }),
      });
      setCreateOpen(false);
      showToast(t("createSuccess"), "success");
      await fetchCustomers();
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        window.location.href = "/api/admin-auth/sign-in";
        return;
      }
      showToast(
        err instanceof ApiError ? err.message : t("actionError"),
        "error",
      );
    } finally {
      setCreateLoading(false);
    }
  };

  // -----------------------------------------------------------------------
  // Delete
  // -----------------------------------------------------------------------

  const openDelete = (customer: Customer) => {
    setDeleteTarget(customer);
    setDeleteOpen(true);
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    setDeleteLoading(true);
    try {
      await adminFetch(`/api/admin/customers/${deleteTarget.id}`, {
        method: "DELETE",
      });
      setDeleteOpen(false);
      showToast(t("deleteSuccess"), "success");
      await fetchCustomers();
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        window.location.href = "/api/admin-auth/sign-in";
        return;
      }
      showToast(
        err instanceof ApiError ? err.message : t("actionError"),
        "error",
      );
    } finally {
      setDeleteLoading(false);
    }
  };

  // -----------------------------------------------------------------------
  // Retry provision
  // -----------------------------------------------------------------------

  const openRetry = (customer: Customer) => {
    setRetryTarget(customer);
    setRetryOpen(true);
  };

  const handleRetry = async () => {
    if (!retryTarget) return;
    setRetryLoading(true);
    try {
      const result = await adminFetch<{ databaseStatus: string }>(
        `/api/admin/customers/${retryTarget.id}/retry-provision`,
        { method: "POST" },
      );
      setRetryOpen(false);
      if (result.databaseStatus === "active") {
        showToast(t("actionSuccess"), "success");
      } else {
        showToast(t("actionError"), "error");
      }
      await fetchCustomers();
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        window.location.href = "/api/admin-auth/sign-in";
        return;
      }
      showToast(
        err instanceof ApiError ? err.message : t("actionError"),
        "error",
      );
    } finally {
      setRetryLoading(false);
    }
  };

  // -----------------------------------------------------------------------
  // Badge variants
  // -----------------------------------------------------------------------

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

  const dbStatusVariant = (status: string) => {
    switch (status) {
      case "active":
        return "default" as const;
      case "failed":
        return "destructive" as const;
      default:
        return "secondary" as const;
    }
  };

  // -----------------------------------------------------------------------
  // Render
  // -----------------------------------------------------------------------

  const createDisabled =
    createLoading ||
    !createName.trim() ||
    !createExternalKey.trim() ||
    !createManagerId;

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

      {/* Toolbar */}
      <div className="flex justify-end">
        <Button type="button" onClick={openCreate}>
          {t("create")}
        </Button>
      </div>

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
        (customers.length === 0 ? (
          <div className="flex items-center justify-center py-12">
            <p className="text-sm text-muted-foreground">{t("noResults")}</p>
          </div>
        ) : (
          <div className="rounded-md border border-border bg-card">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("name")}</TableHead>
                  <TableHead>{t("externalKey")}</TableHead>
                  <TableHead>{t("status")}</TableHead>
                  <TableHead>{t("databaseStatus")}</TableHead>
                  <TableHead>{t("actions")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {customers.map((customer) => (
                  <TableRow key={customer.id}>
                    <TableCell>
                      <span className="font-medium">{customer.name}</span>
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {customer.externalKey}
                    </TableCell>
                    <TableCell>
                      <Badge variant={statusVariant(customer.status)}>
                        {t(
                          customer.status as
                            | "active"
                            | "suspended"
                            | "disabled",
                        )}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <Badge variant={dbStatusVariant(customer.databaseStatus)}>
                        {t(
                          customer.databaseStatus as
                            | "active"
                            | "provisioning"
                            | "failed",
                        )}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        {customer.databaseStatus === "failed" && (
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={() => openRetry(customer)}
                          >
                            {t("retryProvision")}
                          </Button>
                        )}
                        <Button
                          type="button"
                          variant="destructive"
                          size="sm"
                          onClick={() => openDelete(customer)}
                        >
                          {tCommon("delete")}
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        ))}

      {/* Create dialog */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("createTitle")}</DialogTitle>
            <DialogDescription>{t("createDescription")}</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <label
                htmlFor="customer-name"
                className="text-sm font-medium text-foreground"
              >
                {t("name")}
              </label>
              <Input
                id="customer-name"
                value={createName}
                onChange={(e) => setCreateName(e.target.value)}
                disabled={createLoading}
              />
            </div>
            <div className="space-y-2">
              <label
                htmlFor="customer-external-key"
                className="text-sm font-medium text-foreground"
              >
                {t("externalKey")}
              </label>
              <Input
                id="customer-external-key"
                value={createExternalKey}
                onChange={(e) => setCreateExternalKey(e.target.value)}
                disabled={createLoading}
              />
            </div>
            <div className="space-y-2">
              <label
                htmlFor="customer-manager"
                className="text-sm font-medium text-foreground"
              >
                {t("managerAccountId")}
              </label>
              <Select
                id="customer-manager"
                value={createManagerId}
                onChange={(e) => setCreateManagerId(e.target.value)}
                disabled={createLoading}
              >
                <option value="" disabled>
                  —
                </option>
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.displayName || a.username}
                  </option>
                ))}
              </Select>
            </div>
            <div className="space-y-2">
              <label
                htmlFor="customer-description"
                className="text-sm font-medium text-foreground"
              >
                {t("descriptionField")}
              </label>
              <Input
                id="customer-description"
                value={createDescription}
                onChange={(e) => setCreateDescription(e.target.value)}
                disabled={createLoading}
              />
            </div>
          </div>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline" disabled={createLoading}>
                {tCommon("cancel")}
              </Button>
            </DialogClose>
            <Button
              type="button"
              disabled={createDisabled}
              onClick={handleCreate}
            >
              {createLoading ? tCommon("loading") : t("create")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete dialog */}
      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("deleteTitle")}</DialogTitle>
            <DialogDescription>
              {t("deleteConfirm", { name: deleteTarget?.name ?? "" })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline" disabled={deleteLoading}>
                {tCommon("cancel")}
              </Button>
            </DialogClose>
            <Button
              type="button"
              variant="destructive"
              disabled={deleteLoading}
              onClick={handleDelete}
            >
              {deleteLoading ? tCommon("loading") : tCommon("delete")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Retry provision dialog */}
      <Dialog open={retryOpen} onOpenChange={setRetryOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("retryProvisionTitle")}</DialogTitle>
            <DialogDescription>
              {t("retryProvisionConfirm", { name: retryTarget?.name ?? "" })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline" disabled={retryLoading}>
                {tCommon("cancel")}
              </Button>
            </DialogClose>
            <Button type="button" disabled={retryLoading} onClick={handleRetry}>
              {retryLoading ? tCommon("loading") : t("retryProvision")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
