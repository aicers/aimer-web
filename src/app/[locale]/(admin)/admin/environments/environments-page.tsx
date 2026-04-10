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

interface Environment {
  id: number;
  aiceId: string;
  name: string;
  description: string | null;
  status: string;
  createdAt: string;
  updatedAt: string;
  customerCount: number;
  keyCount: number;
}

interface LinkedCustomer {
  customerId: string;
  customerName: string;
  externalKey: string;
  createdAt: string;
}

interface TrustRegistryKey {
  id: number;
  aiceId: string;
  issuer: string;
  kid: string;
  publicKey: unknown;
  description: string | null;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

interface Customer {
  id: string;
  name: string;
  externalKey: string;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function EnvironmentsPage() {
  const t = useTranslations("adminEnvironments");
  const tCommon = useTranslations("common");

  const [environments, setEnvironments] = useState<Environment[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Create dialog
  const [createOpen, setCreateOpen] = useState(false);
  const [createLoading, setCreateLoading] = useState(false);
  const [createAiceId, setCreateAiceId] = useState("");
  const [createName, setCreateName] = useState("");
  const [createDescription, setCreateDescription] = useState("");
  const [createStatus, setCreateStatus] = useState("active");
  const [createIncludeKey, setCreateIncludeKey] = useState(false);
  const [createIssuer, setCreateIssuer] = useState("");
  const [createKid, setCreateKid] = useState("");
  const [createPublicKey, setCreatePublicKey] = useState("");
  const [createKeyDescription, setCreateKeyDescription] = useState("");

  // Edit dialog
  const [editOpen, setEditOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<Environment | null>(null);
  const [editLoading, setEditLoading] = useState(false);
  const [editName, setEditName] = useState("");
  const [editDescription, setEditDescription] = useState("");
  const [editStatus, setEditStatus] = useState("");

  // Delete dialog
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Environment | null>(null);
  const [deleteLoading, setDeleteLoading] = useState(false);

  // Detail panel
  const [detailEnv, setDetailEnv] = useState<Environment | null>(null);
  const [detailTab, setDetailTab] = useState<"customers" | "keys">("customers");

  // Customer mappings
  const [linkedCustomers, setLinkedCustomers] = useState<LinkedCustomer[]>([]);
  const [allCustomers, setAllCustomers] = useState<Customer[]>([]);
  const [linkOpen, setLinkOpen] = useState(false);
  const [linkCustomerId, setLinkCustomerId] = useState("");
  const [linkLoading, setLinkLoading] = useState(false);
  const [unlinkOpen, setUnlinkOpen] = useState(false);
  const [unlinkTarget, setUnlinkTarget] = useState<LinkedCustomer | null>(null);
  const [unlinkLoading, setUnlinkLoading] = useState(false);

  // Trust registry keys
  const [trustKeys, setTrustKeys] = useState<TrustRegistryKey[]>([]);
  const [registerKeyOpen, setRegisterKeyOpen] = useState(false);
  const [registerKeyLoading, setRegisterKeyLoading] = useState(false);
  const [regIssuer, setRegIssuer] = useState("");
  const [regKid, setRegKid] = useState("");
  const [regPublicKey, setRegPublicKey] = useState("");
  const [regKeyDescription, setRegKeyDescription] = useState("");
  const [removeKeyOpen, setRemoveKeyOpen] = useState(false);
  const [removeKeyTarget, setRemoveKeyTarget] =
    useState<TrustRegistryKey | null>(null);
  const [removeKeyLoading, setRemoveKeyLoading] = useState(false);

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

  const fetchEnvironments = useCallback(async () => {
    try {
      const data = await adminFetch<{ environments: Environment[] }>(
        "/api/admin/environments",
      );
      setEnvironments(data.environments);
      setError(null);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        window.location.href = "/api/admin-auth/sign-in";
        return;
      }
      setError(t("errorLoading"));
    }
  }, [t]);

  const fetchAllCustomers = useCallback(async () => {
    try {
      const data = await adminFetch<{ customers: Customer[] }>(
        "/api/admin/customers",
      );
      setAllCustomers(data.customers);
    } catch {
      // Non-critical
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    (async () => {
      await Promise.all([fetchEnvironments(), fetchAllCustomers()]);
      if (!cancelled) setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [fetchEnvironments, fetchAllCustomers]);

  const fetchLinkedCustomers = useCallback(async (aiceId: string) => {
    try {
      const data = await adminFetch<{ customers: LinkedCustomer[] }>(
        `/api/admin/environments/${aiceId}/customers`,
      );
      setLinkedCustomers(data.customers);
    } catch {
      setLinkedCustomers([]);
    }
  }, []);

  const fetchTrustKeys = useCallback(async (aiceId: string) => {
    try {
      const data = await adminFetch<{ keys: TrustRegistryKey[] }>(
        `/api/admin/environments/${aiceId}/trust-registry`,
      );
      setTrustKeys(data.keys);
    } catch {
      setTrustKeys([]);
    }
  }, []);

  // -----------------------------------------------------------------------
  // Create
  // -----------------------------------------------------------------------

  const openCreate = () => {
    setCreateAiceId("");
    setCreateName("");
    setCreateDescription("");
    setCreateStatus("active");
    setCreateIncludeKey(false);
    setCreateIssuer("");
    setCreateKid("");
    setCreatePublicKey("");
    setCreateKeyDescription("");
    setCreateOpen(true);
  };

  const handleCreate = async () => {
    setCreateLoading(true);
    try {
      let trustRegistryKey: Record<string, unknown> | undefined;
      if (createIncludeKey) {
        let parsedKey: unknown;
        try {
          parsedKey = JSON.parse(createPublicKey);
        } catch {
          showToast(t("invalidPublicKey"), "error");
          setCreateLoading(false);
          return;
        }
        trustRegistryKey = {
          issuer: createIssuer,
          kid: createKid,
          publicKey: parsedKey,
          description: createKeyDescription || undefined,
        };
      }

      await adminFetch("/api/admin/environments", {
        method: "POST",
        body: JSON.stringify({
          aiceId: createAiceId,
          name: createName,
          description: createDescription || undefined,
          status: createStatus,
          trustRegistryKey,
        }),
      });
      setCreateOpen(false);
      showToast(t("createSuccess"), "success");
      await fetchEnvironments();
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        window.location.href = "/api/admin-auth/sign-in";
        return;
      }
      if (err instanceof ApiError && err.message === "aice_id_conflict") {
        showToast(t("aiceIdConflict"), "error");
      } else {
        showToast(
          err instanceof ApiError ? err.message : t("actionError"),
          "error",
        );
      }
    } finally {
      setCreateLoading(false);
    }
  };

  // -----------------------------------------------------------------------
  // Edit
  // -----------------------------------------------------------------------

  const openEdit = (env: Environment) => {
    setEditTarget(env);
    setEditName(env.name);
    setEditDescription(env.description ?? "");
    setEditStatus(env.status);
    setEditOpen(true);
  };

  const handleEdit = async () => {
    if (!editTarget) return;
    setEditLoading(true);
    try {
      await adminFetch(`/api/admin/environments/${editTarget.aiceId}`, {
        method: "PATCH",
        body: JSON.stringify({
          name: editName,
          description: editDescription || null,
          status: editStatus,
        }),
      });
      setEditOpen(false);
      showToast(t("updateSuccess"), "success");
      await fetchEnvironments();
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
      setEditLoading(false);
    }
  };

  // -----------------------------------------------------------------------
  // Delete
  // -----------------------------------------------------------------------

  const openDelete = (env: Environment) => {
    setDeleteTarget(env);
    setDeleteOpen(true);
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    setDeleteLoading(true);
    try {
      await adminFetch(`/api/admin/environments/${deleteTarget.aiceId}`, {
        method: "DELETE",
      });
      setDeleteOpen(false);
      if (detailEnv?.aiceId === deleteTarget.aiceId) {
        setDetailEnv(null);
      }
      showToast(t("deleteSuccess"), "success");
      await fetchEnvironments();
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
  // Detail panel
  // -----------------------------------------------------------------------

  const openDetail = (env: Environment, tab: "customers" | "keys") => {
    setDetailEnv(env);
    setDetailTab(tab);
    if (tab === "customers") {
      fetchLinkedCustomers(env.aiceId);
    } else {
      fetchTrustKeys(env.aiceId);
    }
  };

  const closeDetail = () => {
    setDetailEnv(null);
  };

  // -----------------------------------------------------------------------
  // Link customer
  // -----------------------------------------------------------------------

  const openLink = () => {
    setLinkCustomerId("");
    setLinkOpen(true);
  };

  const handleLink = async () => {
    if (!detailEnv) return;
    setLinkLoading(true);
    try {
      await adminFetch(
        `/api/admin/environments/${detailEnv.aiceId}/customers`,
        {
          method: "POST",
          body: JSON.stringify({ customerId: linkCustomerId }),
        },
      );
      setLinkOpen(false);
      showToast(t("linkSuccess"), "success");
      await fetchLinkedCustomers(detailEnv.aiceId);
      await fetchEnvironments();
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
      setLinkLoading(false);
    }
  };

  // -----------------------------------------------------------------------
  // Unlink customer
  // -----------------------------------------------------------------------

  const openUnlink = (customer: LinkedCustomer) => {
    setUnlinkTarget(customer);
    setUnlinkOpen(true);
  };

  const handleUnlink = async () => {
    if (!detailEnv || !unlinkTarget) return;
    setUnlinkLoading(true);
    try {
      await adminFetch(
        `/api/admin/environments/${detailEnv.aiceId}/customers/${unlinkTarget.customerId}`,
        { method: "DELETE" },
      );
      setUnlinkOpen(false);
      showToast(t("unlinkSuccess"), "success");
      await fetchLinkedCustomers(detailEnv.aiceId);
      await fetchEnvironments();
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
      setUnlinkLoading(false);
    }
  };

  // -----------------------------------------------------------------------
  // Register key
  // -----------------------------------------------------------------------

  const openRegisterKey = () => {
    setRegIssuer("");
    setRegKid("");
    setRegPublicKey("");
    setRegKeyDescription("");
    setRegisterKeyOpen(true);
  };

  const handleRegisterKey = async () => {
    if (!detailEnv) return;
    setRegisterKeyLoading(true);
    try {
      let parsedKey: unknown;
      try {
        parsedKey = JSON.parse(regPublicKey);
      } catch {
        showToast(t("invalidPublicKey"), "error");
        setRegisterKeyLoading(false);
        return;
      }
      await adminFetch(
        `/api/admin/environments/${detailEnv.aiceId}/trust-registry`,
        {
          method: "POST",
          body: JSON.stringify({
            issuer: regIssuer,
            kid: regKid,
            publicKey: parsedKey,
            description: regKeyDescription || undefined,
          }),
        },
      );
      setRegisterKeyOpen(false);
      showToast(t("registerKeySuccess"), "success");
      await fetchTrustKeys(detailEnv.aiceId);
      await fetchEnvironments();
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
      setRegisterKeyLoading(false);
    }
  };

  // -----------------------------------------------------------------------
  // Toggle key enabled/disabled
  // -----------------------------------------------------------------------

  const handleToggleKey = async (key: TrustRegistryKey) => {
    if (!detailEnv) return;
    try {
      await adminFetch(
        `/api/admin/environments/${detailEnv.aiceId}/trust-registry/${key.id}`,
        {
          method: "PATCH",
          body: JSON.stringify({ enabled: !key.enabled }),
        },
      );
      showToast(t("keyStatusSuccess"), "success");
      await fetchTrustKeys(detailEnv.aiceId);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        window.location.href = "/api/admin-auth/sign-in";
        return;
      }
      showToast(
        err instanceof ApiError ? err.message : t("actionError"),
        "error",
      );
    }
  };

  // -----------------------------------------------------------------------
  // Remove key
  // -----------------------------------------------------------------------

  const openRemoveKey = (key: TrustRegistryKey) => {
    setRemoveKeyTarget(key);
    setRemoveKeyOpen(true);
  };

  const handleRemoveKey = async () => {
    if (!detailEnv || !removeKeyTarget) return;
    setRemoveKeyLoading(true);
    try {
      await adminFetch(
        `/api/admin/environments/${detailEnv.aiceId}/trust-registry/${removeKeyTarget.id}`,
        { method: "DELETE" },
      );
      setRemoveKeyOpen(false);
      showToast(t("removeKeySuccess"), "success");
      await fetchTrustKeys(detailEnv.aiceId);
      await fetchEnvironments();
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
      setRemoveKeyLoading(false);
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

  // -----------------------------------------------------------------------
  // Render
  // -----------------------------------------------------------------------

  const createDisabled =
    createLoading || !createAiceId.trim() || !createName.trim();

  const createKeyDisabled =
    createIncludeKey &&
    (!createIssuer.trim() || !createKid.trim() || !createPublicKey.trim());

  const linkedCustomerIds = new Set(linkedCustomers.map((c) => c.customerId));
  const availableCustomers = allCustomers.filter(
    (c) => !linkedCustomerIds.has(c.id),
  );

  // Detail panel view
  if (detailEnv) {
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

        {/* Header */}
        <div className="flex items-center gap-4">
          <Button type="button" variant="outline" onClick={closeDetail}>
            {t("backToList")}
          </Button>
          <div>
            <h2 className="text-lg font-semibold">{detailEnv.name}</h2>
            <p className="text-sm text-muted-foreground">{detailEnv.aiceId}</p>
          </div>
        </div>

        {/* Tabs */}
        <div className="flex gap-2 border-b border-border pb-2">
          <Button
            type="button"
            variant={detailTab === "customers" ? "default" : "outline"}
            size="sm"
            onClick={() => {
              setDetailTab("customers");
              fetchLinkedCustomers(detailEnv.aiceId);
            }}
          >
            {t("manageCustomers")}
          </Button>
          <Button
            type="button"
            variant={detailTab === "keys" ? "default" : "outline"}
            size="sm"
            onClick={() => {
              setDetailTab("keys");
              fetchTrustKeys(detailEnv.aiceId);
            }}
          >
            {t("manageKeys")}
          </Button>
        </div>

        {/* Customer mapping tab */}
        {detailTab === "customers" && (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-base font-medium">{t("linkedCustomers")}</h3>
              <Button type="button" size="sm" onClick={openLink}>
                {t("linkCustomer")}
              </Button>
            </div>

            {linkedCustomers.length === 0 ? (
              <p className="py-8 text-center text-sm text-muted-foreground">
                {t("noLinkedCustomers")}
              </p>
            ) : (
              <div className="rounded-md border border-border bg-card">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t("name")}</TableHead>
                      <TableHead>{t("actions")}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {linkedCustomers.map((c) => (
                      <TableRow key={c.customerId}>
                        <TableCell>
                          <span className="font-medium">{c.customerName}</span>
                          <span className="ml-2 text-muted-foreground">
                            {c.externalKey}
                          </span>
                        </TableCell>
                        <TableCell>
                          <Button
                            type="button"
                            variant="destructive"
                            size="sm"
                            onClick={() => openUnlink(c)}
                          >
                            {tCommon("delete")}
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </div>
        )}

        {/* Trust registry keys tab */}
        {detailTab === "keys" && (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-base font-medium">
                {t("trustRegistryKeys")}
              </h3>
              <Button type="button" size="sm" onClick={openRegisterKey}>
                {t("registerKey")}
              </Button>
            </div>

            {trustKeys.length === 0 ? (
              <p className="py-8 text-center text-sm text-muted-foreground">
                {t("noKeys")}
              </p>
            ) : (
              <div className="rounded-md border border-border bg-card">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t("issuer")}</TableHead>
                      <TableHead>{t("kid")}</TableHead>
                      <TableHead>{t("status")}</TableHead>
                      <TableHead>{t("actions")}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {trustKeys.map((key) => (
                      <TableRow key={key.id}>
                        <TableCell>
                          <span className="font-medium">{key.issuer}</span>
                          {key.description && (
                            <p className="text-xs text-muted-foreground">
                              {key.description}
                            </p>
                          )}
                        </TableCell>
                        <TableCell className="text-muted-foreground">
                          {key.kid}
                        </TableCell>
                        <TableCell>
                          <Badge
                            variant={key.enabled ? "default" : "secondary"}
                          >
                            {key.enabled ? t("enabled") : t("disabledLabel")}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          <div className="flex items-center gap-2">
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              onClick={() => handleToggleKey(key)}
                            >
                              {key.enabled ? t("disableKey") : t("enableKey")}
                            </Button>
                            <Button
                              type="button"
                              variant="destructive"
                              size="sm"
                              onClick={() => openRemoveKey(key)}
                            >
                              {t("removeKey")}
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </div>
        )}

        {/* Link customer dialog */}
        <Dialog open={linkOpen} onOpenChange={setLinkOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{t("linkCustomer")}</DialogTitle>
              <DialogDescription>
                {t("linkCustomerDescription")}
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4 py-2">
              <div className="space-y-2">
                <label
                  htmlFor="link-customer"
                  className="text-sm font-medium text-foreground"
                >
                  {t("selectCustomer")}
                </label>
                <Select
                  id="link-customer"
                  value={linkCustomerId}
                  onChange={(e) => setLinkCustomerId(e.target.value)}
                  disabled={linkLoading}
                >
                  <option value="" disabled>
                    —
                  </option>
                  {availableCustomers.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name} ({c.externalKey})
                    </option>
                  ))}
                </Select>
              </div>
            </div>
            <DialogFooter>
              <DialogClose asChild>
                <Button type="button" variant="outline" disabled={linkLoading}>
                  {tCommon("cancel")}
                </Button>
              </DialogClose>
              <Button
                type="button"
                disabled={linkLoading || !linkCustomerId}
                onClick={handleLink}
              >
                {linkLoading ? tCommon("loading") : t("linkCustomer")}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* Unlink customer dialog */}
        <Dialog open={unlinkOpen} onOpenChange={setUnlinkOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{t("unlinkTitle")}</DialogTitle>
              <DialogDescription>
                {t("unlinkConfirm", {
                  name: unlinkTarget?.customerName ?? "",
                })}
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <DialogClose asChild>
                <Button
                  type="button"
                  variant="outline"
                  disabled={unlinkLoading}
                >
                  {tCommon("cancel")}
                </Button>
              </DialogClose>
              <Button
                type="button"
                variant="destructive"
                disabled={unlinkLoading}
                onClick={handleUnlink}
              >
                {unlinkLoading ? tCommon("loading") : tCommon("delete")}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* Register key dialog */}
        <Dialog open={registerKeyOpen} onOpenChange={setRegisterKeyOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{t("registerKey")}</DialogTitle>
              <DialogDescription>
                {t("registerKeyDescription")}
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4 py-2">
              <div className="space-y-2">
                <label
                  htmlFor="reg-issuer"
                  className="text-sm font-medium text-foreground"
                >
                  {t("issuer")}
                </label>
                <Input
                  id="reg-issuer"
                  value={regIssuer}
                  onChange={(e) => setRegIssuer(e.target.value)}
                  disabled={registerKeyLoading}
                />
              </div>
              <div className="space-y-2">
                <label
                  htmlFor="reg-kid"
                  className="text-sm font-medium text-foreground"
                >
                  {t("kid")}
                </label>
                <Input
                  id="reg-kid"
                  value={regKid}
                  onChange={(e) => setRegKid(e.target.value)}
                  disabled={registerKeyLoading}
                />
              </div>
              <div className="space-y-2">
                <label
                  htmlFor="reg-public-key"
                  className="text-sm font-medium text-foreground"
                >
                  {t("publicKey")}
                </label>
                <textarea
                  id="reg-public-key"
                  className="flex min-h-[100px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
                  value={regPublicKey}
                  onChange={(e) => setRegPublicKey(e.target.value)}
                  placeholder={t("publicKeyPlaceholder")}
                  disabled={registerKeyLoading}
                />
              </div>
              <div className="space-y-2">
                <label
                  htmlFor="reg-key-description"
                  className="text-sm font-medium text-foreground"
                >
                  {t("keyDescription")}
                </label>
                <Input
                  id="reg-key-description"
                  value={regKeyDescription}
                  onChange={(e) => setRegKeyDescription(e.target.value)}
                  disabled={registerKeyLoading}
                />
              </div>
            </div>
            <DialogFooter>
              <DialogClose asChild>
                <Button
                  type="button"
                  variant="outline"
                  disabled={registerKeyLoading}
                >
                  {tCommon("cancel")}
                </Button>
              </DialogClose>
              <Button
                type="button"
                disabled={
                  registerKeyLoading ||
                  !regIssuer.trim() ||
                  !regKid.trim() ||
                  !regPublicKey.trim()
                }
                onClick={handleRegisterKey}
              >
                {registerKeyLoading ? tCommon("loading") : t("registerKey")}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* Remove key dialog */}
        <Dialog open={removeKeyOpen} onOpenChange={setRemoveKeyOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{t("removeKeyTitle")}</DialogTitle>
              <DialogDescription>
                {t("removeKeyConfirm", {
                  kid: removeKeyTarget?.kid ?? "",
                  issuer: removeKeyTarget?.issuer ?? "",
                })}
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <DialogClose asChild>
                <Button
                  type="button"
                  variant="outline"
                  disabled={removeKeyLoading}
                >
                  {tCommon("cancel")}
                </Button>
              </DialogClose>
              <Button
                type="button"
                variant="destructive"
                disabled={removeKeyLoading}
                onClick={handleRemoveKey}
              >
                {removeKeyLoading ? tCommon("loading") : t("removeKey")}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    );
  }

  // Main list view
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
        (environments.length === 0 ? (
          <div className="flex items-center justify-center py-12">
            <p className="text-sm text-muted-foreground">{t("noResults")}</p>
          </div>
        ) : (
          <div className="rounded-md border border-border bg-card">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("aiceId")}</TableHead>
                  <TableHead>{t("name")}</TableHead>
                  <TableHead>{t("status")}</TableHead>
                  <TableHead>{t("customers")}</TableHead>
                  <TableHead>{t("keys")}</TableHead>
                  <TableHead>{t("actions")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {environments.map((env) => (
                  <TableRow key={env.aiceId}>
                    <TableCell className="font-mono text-sm">
                      {env.aiceId}
                    </TableCell>
                    <TableCell>
                      <span className="font-medium">{env.name}</span>
                      {env.description && (
                        <p className="text-xs text-muted-foreground">
                          {env.description}
                        </p>
                      )}
                    </TableCell>
                    <TableCell>
                      <Badge variant={statusVariant(env.status)}>
                        {t(env.status as "active" | "suspended" | "disabled")}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => openDetail(env, "customers")}
                      >
                        {env.customerCount}
                      </Button>
                    </TableCell>
                    <TableCell>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => openDetail(env, "keys")}
                      >
                        {env.keyCount}
                      </Button>
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => openEdit(env)}
                        >
                          {t("edit")}
                        </Button>
                        <Button
                          type="button"
                          variant="destructive"
                          size="sm"
                          onClick={() => openDelete(env)}
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
        <DialogContent className="max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{t("createTitle")}</DialogTitle>
            <DialogDescription>{t("createDescription")}</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <label
                htmlFor="env-aice-id"
                className="text-sm font-medium text-foreground"
              >
                {t("aiceId")}
              </label>
              <Input
                id="env-aice-id"
                value={createAiceId}
                onChange={(e) => setCreateAiceId(e.target.value)}
                disabled={createLoading}
              />
            </div>
            <div className="space-y-2">
              <label
                htmlFor="env-name"
                className="text-sm font-medium text-foreground"
              >
                {t("name")}
              </label>
              <Input
                id="env-name"
                value={createName}
                onChange={(e) => setCreateName(e.target.value)}
                disabled={createLoading}
              />
            </div>
            <div className="space-y-2">
              <label
                htmlFor="env-description"
                className="text-sm font-medium text-foreground"
              >
                {t("descriptionField")}
              </label>
              <Input
                id="env-description"
                value={createDescription}
                onChange={(e) => setCreateDescription(e.target.value)}
                disabled={createLoading}
              />
            </div>
            <div className="space-y-2">
              <label
                htmlFor="env-status"
                className="text-sm font-medium text-foreground"
              >
                {t("status")}
              </label>
              <Select
                id="env-status"
                value={createStatus}
                onChange={(e) => setCreateStatus(e.target.value)}
                disabled={createLoading}
              >
                <option value="active">{t("active")}</option>
                <option value="suspended">{t("suspended")}</option>
                <option value="disabled">{t("disabled")}</option>
              </Select>
            </div>

            {/* Trust registry key toggle */}
            <div className="border-t border-border pt-4">
              <label className="flex items-center gap-2 text-sm font-medium text-foreground">
                <input
                  type="checkbox"
                  checked={createIncludeKey}
                  onChange={(e) => setCreateIncludeKey(e.target.checked)}
                  disabled={createLoading}
                  className="h-4 w-4 rounded border-input"
                />
                {t("trustRegistryKey")}
              </label>
            </div>

            {createIncludeKey && (
              <>
                <div className="space-y-2">
                  <label
                    htmlFor="env-issuer"
                    className="text-sm font-medium text-foreground"
                  >
                    {t("issuer")}
                  </label>
                  <Input
                    id="env-issuer"
                    value={createIssuer}
                    onChange={(e) => setCreateIssuer(e.target.value)}
                    disabled={createLoading}
                  />
                </div>
                <div className="space-y-2">
                  <label
                    htmlFor="env-kid"
                    className="text-sm font-medium text-foreground"
                  >
                    {t("kid")}
                  </label>
                  <Input
                    id="env-kid"
                    value={createKid}
                    onChange={(e) => setCreateKid(e.target.value)}
                    disabled={createLoading}
                  />
                </div>
                <div className="space-y-2">
                  <label
                    htmlFor="env-public-key"
                    className="text-sm font-medium text-foreground"
                  >
                    {t("publicKey")}
                  </label>
                  <textarea
                    id="env-public-key"
                    className="flex min-h-[100px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
                    value={createPublicKey}
                    onChange={(e) => setCreatePublicKey(e.target.value)}
                    placeholder={t("publicKeyPlaceholder")}
                    disabled={createLoading}
                  />
                </div>
                <div className="space-y-2">
                  <label
                    htmlFor="env-key-description"
                    className="text-sm font-medium text-foreground"
                  >
                    {t("keyDescription")}
                  </label>
                  <Input
                    id="env-key-description"
                    value={createKeyDescription}
                    onChange={(e) => setCreateKeyDescription(e.target.value)}
                    disabled={createLoading}
                  />
                </div>
              </>
            )}
          </div>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline" disabled={createLoading}>
                {tCommon("cancel")}
              </Button>
            </DialogClose>
            <Button
              type="button"
              disabled={createDisabled || createKeyDisabled}
              onClick={handleCreate}
            >
              {createLoading ? tCommon("loading") : t("create")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit dialog */}
      <Dialog open={editOpen} onOpenChange={setEditOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("editTitle")}</DialogTitle>
            <DialogDescription>{t("editDescription")}</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <label
                htmlFor="edit-name"
                className="text-sm font-medium text-foreground"
              >
                {t("name")}
              </label>
              <Input
                id="edit-name"
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                disabled={editLoading}
              />
            </div>
            <div className="space-y-2">
              <label
                htmlFor="edit-description"
                className="text-sm font-medium text-foreground"
              >
                {t("descriptionField")}
              </label>
              <Input
                id="edit-description"
                value={editDescription}
                onChange={(e) => setEditDescription(e.target.value)}
                disabled={editLoading}
              />
            </div>
            <div className="space-y-2">
              <label
                htmlFor="edit-status"
                className="text-sm font-medium text-foreground"
              >
                {t("status")}
              </label>
              <Select
                id="edit-status"
                value={editStatus}
                onChange={(e) => setEditStatus(e.target.value)}
                disabled={editLoading}
              >
                <option value="active">{t("active")}</option>
                <option value="suspended">{t("suspended")}</option>
                <option value="disabled">{t("disabled")}</option>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline" disabled={editLoading}>
                {tCommon("cancel")}
              </Button>
            </DialogClose>
            <Button
              type="button"
              disabled={editLoading || !editName.trim()}
              onClick={handleEdit}
            >
              {editLoading ? tCommon("loading") : tCommon("save")}
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
    </div>
  );
}
