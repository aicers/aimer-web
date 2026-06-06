"use client";

import { useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useState } from "react";

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

interface Analyst {
  accountId: string;
  email: string | null;
  displayName: string;
  analystEligible: boolean;
  assignedCustomerIds: string[];
  lastSignInAt: string | null;
}

interface Customer {
  id: string;
  name: string;
  externalKey: string;
  status: string;
}

interface Account {
  id: string;
  username: string;
  displayName: string | null;
  email: string | null;
  status: string;
}

interface Invitation {
  id: string;
  email: string;
  customerIds: string[];
  invitedBy: string;
  expiresAt: string;
}

interface AnalystDetail {
  accountId: string;
  assignedCustomers: { id: string; name: string; status: string }[];
}

// ---------------------------------------------------------------------------
// Customer multi-select (checkbox list)
// ---------------------------------------------------------------------------

function CustomerMultiSelect({
  customers,
  selected,
  onToggle,
  disabled,
  emptyText,
}: {
  customers: Customer[];
  selected: string[];
  onToggle: (id: string) => void;
  disabled: boolean;
  emptyText: string;
}) {
  if (customers.length === 0) {
    return <p className="text-sm text-muted-foreground">{emptyText}</p>;
  }
  return (
    <div className="max-h-48 space-y-1 overflow-y-auto rounded-lg border border-border p-2">
      {customers.map((c) => (
        <label
          key={c.id}
          className="flex items-center gap-2 rounded px-2 py-1 text-sm hover:bg-accent"
        >
          <input
            type="checkbox"
            checked={selected.includes(c.id)}
            onChange={() => onToggle(c.id)}
            disabled={disabled}
            className="h-4 w-4"
          />
          <span className="text-foreground">{c.name}</span>
          <span className="text-xs text-muted-foreground">{c.externalKey}</span>
        </label>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function AnalystsPage() {
  const t = useTranslations("adminAnalysts");
  const tCommon = useTranslations("common");

  const [analysts, setAnalysts] = useState<Analyst[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [invitations, setInvitations] = useState<Invitation[]>([]);
  const [invitationsLoadError, setInvitationsLoadError] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [customersForbidden, setCustomersForbidden] = useState(false);
  const [accountsForbidden, setAccountsForbidden] = useState(false);
  const [customersLoadError, setCustomersLoadError] = useState(false);
  const [accountsLoadError, setAccountsLoadError] = useState(false);

  // Invite dialog
  const [inviteOpen, setInviteOpen] = useState(false);
  const [inviteLoading, setInviteLoading] = useState(false);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteCustomerIds, setInviteCustomerIds] = useState<string[]>([]);

  // Designate dialog
  const [designateOpen, setDesignateOpen] = useState(false);
  const [designateLoading, setDesignateLoading] = useState(false);
  const [designateSearch, setDesignateSearch] = useState("");
  const [designateAccountId, setDesignateAccountId] = useState("");
  const [designateCustomerIds, setDesignateCustomerIds] = useState<string[]>(
    [],
  );

  // Revoke analyst dialog
  const [revokeOpen, setRevokeOpen] = useState(false);
  const [revokeTarget, setRevokeTarget] = useState<Analyst | null>(null);
  const [revokeLoading, setRevokeLoading] = useState(false);

  // Revoke invitation dialog
  const [revokeInviteOpen, setRevokeInviteOpen] = useState(false);
  const [revokeInviteTarget, setRevokeInviteTarget] =
    useState<Invitation | null>(null);
  const [revokeInviteLoading, setRevokeInviteLoading] = useState(false);

  // Manage assignments dialog
  const [manageOpen, setManageOpen] = useState(false);
  const [manageTarget, setManageTarget] = useState<Analyst | null>(null);
  const [manageDetail, setManageDetail] = useState<AnalystDetail | null>(null);
  const [manageDetailLoading, setManageDetailLoading] = useState(false);
  const [manageDetailError, setManageDetailError] = useState(false);
  const [manageActionLoading, setManageActionLoading] = useState(false);
  const [addCustomerId, setAddCustomerId] = useState("");

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
  // Derived data
  // -----------------------------------------------------------------------

  // id → name map built once from the full customer list (includes inactive
  // customers so revoked-but-still-assigned chips resolve to a real name).
  const customerNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const c of customers) map.set(c.id, c.name);
    return map;
  }, [customers]);

  // Pickers only offer active customers — the analyst APIs reject non-active
  // customers, so offering them would only produce failed requests.
  const activeCustomers = useMemo(
    () => customers.filter((c) => c.status === "active"),
    [customers],
  );

  // A picker dependency is unavailable when it was denied (403) OR failed to
  // load (500/network). Either way the dependent flows must be blocked rather
  // than silently presenting an empty/degraded picker.
  const customersUnavailable = customersForbidden || customersLoadError;
  const accountsUnavailable = accountsForbidden || accountsLoadError;

  // The account chosen in the designate dialog, resolved against the loaded
  // accounts so the dialog can show an explicit selected-account summary.
  const selectedDesignateAccount = useMemo(
    () => accounts.find((a) => a.id === designateAccountId) ?? null,
    [accounts, designateAccountId],
  );

  const matchingAccounts = useMemo(() => {
    const q = designateSearch.trim().toLowerCase();
    const active = accounts.filter((a) => a.status === "active");
    if (!q) return active.slice(0, 50);
    return active
      .filter((a) => {
        const name = (a.displayName ?? a.username).toLowerCase();
        const email = (a.email ?? "").toLowerCase();
        return (
          name.includes(q) ||
          email.includes(q) ||
          a.username.toLowerCase().includes(q)
        );
      })
      .slice(0, 50);
  }, [accounts, designateSearch]);

  // -----------------------------------------------------------------------
  // Data fetching
  // -----------------------------------------------------------------------

  const fetchAnalysts = useCallback(async () => {
    try {
      const data = await adminFetch<{ analysts: Analyst[] }>(
        "/api/admin/analysts",
      );
      setAnalysts(data.analysts);
      setError(null);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        window.location.href = "/api/admin-auth/sign-in";
        return;
      }
      setError(t("errorLoading"));
    }
  }, [t]);

  const fetchInvitations = useCallback(async () => {
    try {
      const data = await adminFetch<{ invitations: Invitation[] }>(
        "/api/admin/analysts/invitations",
      );
      setInvitations(data.invitations);
      setInvitationsLoadError(false);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        window.location.href = "/api/admin-auth/sign-in";
        return;
      }
      // A failed load must not look like "no pending invitations" — that would
      // hide invites the admin still needs to revoke. Surface an explicit
      // error state instead of silently leaving the list empty.
      setInvitationsLoadError(true);
    }
  }, []);

  const fetchCustomers = useCallback(async () => {
    try {
      const data = await adminFetch<{ customers: Customer[] }>(
        "/api/admin/customers",
      );
      setCustomers(data.customers);
      setCustomersForbidden(false);
      setCustomersLoadError(false);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        window.location.href = "/api/admin-auth/sign-in";
        return;
      }
      // Distinguish a permission denial (a stable config issue) from a
      // transient load failure (500/network) so the banner and disabled
      // actions don't masquerade as "tenant has no active customers".
      if (err instanceof ApiError && err.status === 403) {
        setCustomersForbidden(true);
      } else {
        setCustomersLoadError(true);
      }
    }
  }, []);

  const fetchAccounts = useCallback(async () => {
    try {
      const data = await adminFetch<{ accounts: Account[] }>(
        "/api/admin/accounts",
      );
      setAccounts(data.accounts);
      setAccountsForbidden(false);
      setAccountsLoadError(false);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        window.location.href = "/api/admin-auth/sign-in";
        return;
      }
      // See fetchCustomers: a 403 is a permission problem, anything else is a
      // transient load failure that must not look like "no matching accounts".
      if (err instanceof ApiError && err.status === 403) {
        setAccountsForbidden(true);
      } else {
        setAccountsLoadError(true);
      }
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    (async () => {
      await Promise.all([
        fetchAnalysts(),
        fetchInvitations(),
        fetchCustomers(),
        fetchAccounts(),
      ]);
      if (!cancelled) setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [fetchAnalysts, fetchInvitations, fetchCustomers, fetchAccounts]);

  // -----------------------------------------------------------------------
  // Invite
  // -----------------------------------------------------------------------

  const openInvite = () => {
    setInviteEmail("");
    setInviteCustomerIds([]);
    setInviteOpen(true);
  };

  const handleInvite = async () => {
    setInviteLoading(true);
    try {
      const result = await adminFetch<{ refreshed: boolean }>(
        "/api/admin/analysts/invitations",
        {
          method: "POST",
          body: JSON.stringify({
            email: inviteEmail.trim(),
            customerIds: inviteCustomerIds,
          }),
        },
      );
      setInviteOpen(false);
      showToast(
        result.refreshed ? t("inviteRefreshed") : t("inviteSuccess"),
        "success",
      );
      await Promise.all([fetchInvitations(), fetchAnalysts()]);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        window.location.href = "/api/admin-auth/sign-in";
        return;
      }
      showToast(localizeInviteError(err), "error");
    } finally {
      setInviteLoading(false);
    }
  };

  const localizeInviteError = (err: unknown): string => {
    if (err instanceof ApiError) {
      if (err.message === "invalid_email") return t("errorInvalidEmail");
      if (err.message === "invalid_customer_ids") {
        return t("errorInvalidCustomers");
      }
      if (err.message === "already_assigned") {
        return t("errorAlreadyAssigned");
      }
    }
    return t("actionError");
  };

  // -----------------------------------------------------------------------
  // Designate
  // -----------------------------------------------------------------------

  const openDesignate = () => {
    setDesignateSearch("");
    setDesignateAccountId("");
    setDesignateCustomerIds([]);
    setDesignateOpen(true);
  };

  // Clear the selected account whenever the query changes. Otherwise an admin
  // could pick an account, retype the search so a different account is now
  // visible, and submit the stale (no-longer-shown) selection — the submit
  // button only checks that *some* account id is set. Clearing guarantees the
  // selection always corresponds to a row currently visible in the list.
  const handleDesignateSearchChange = (value: string) => {
    setDesignateSearch(value);
    setDesignateAccountId("");
  };

  const handleDesignate = async () => {
    if (!designateAccountId) return;
    setDesignateLoading(true);
    try {
      await adminFetch("/api/admin/analysts", {
        method: "POST",
        body: JSON.stringify({
          accountId: designateAccountId,
          customerIds: designateCustomerIds,
        }),
      });
      setDesignateOpen(false);
      showToast(t("designateSuccess"), "success");
      await fetchAnalysts();
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        window.location.href = "/api/admin-auth/sign-in";
        return;
      }
      showToast(t("actionError"), "error");
    } finally {
      setDesignateLoading(false);
    }
  };

  // -----------------------------------------------------------------------
  // Revoke analyst
  // -----------------------------------------------------------------------

  const openRevoke = (analyst: Analyst) => {
    setRevokeTarget(analyst);
    setRevokeOpen(true);
  };

  const handleRevoke = async () => {
    if (!revokeTarget) return;
    setRevokeLoading(true);
    try {
      await adminFetch(`/api/admin/analysts/${revokeTarget.accountId}`, {
        method: "PATCH",
        body: JSON.stringify({ analystEligible: false }),
      });
      setRevokeOpen(false);
      showToast(t("revokeSuccess"), "success");
      await fetchAnalysts();
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

  // -----------------------------------------------------------------------
  // Revoke invitation
  // -----------------------------------------------------------------------

  const openRevokeInvite = (invitation: Invitation) => {
    setRevokeInviteTarget(invitation);
    setRevokeInviteOpen(true);
  };

  const handleRevokeInvite = async () => {
    if (!revokeInviteTarget) return;
    setRevokeInviteLoading(true);
    try {
      await adminFetch(
        `/api/admin/analysts/invitations/${revokeInviteTarget.id}`,
        { method: "DELETE" },
      );
      setRevokeInviteOpen(false);
      showToast(t("revokeInvitationSuccess"), "success");
      await fetchInvitations();
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        window.location.href = "/api/admin-auth/sign-in";
        return;
      }
      setRevokeInviteOpen(false);
      showToast(localizeRevokeInviteError(err), "error");
      await fetchInvitations();
    } finally {
      setRevokeInviteLoading(false);
    }
  };

  const localizeRevokeInviteError = (err: unknown): string => {
    if (err instanceof ApiError) {
      if (err.message === "already_expired") return t("errorAlreadyExpired");
      if (err.message === "already_consumed") return t("errorAlreadyConsumed");
      if (err.message === "not_found") return t("errorNotFound");
    }
    return t("actionError");
  };

  // -----------------------------------------------------------------------
  // Manage assignments
  // -----------------------------------------------------------------------

  const fetchManageDetail = useCallback(async (accountId: string) => {
    setManageDetailLoading(true);
    setManageDetailError(false);
    try {
      const data = await adminFetch<AnalystDetail>(
        `/api/admin/analysts/${accountId}`,
      );
      setManageDetail(data);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        window.location.href = "/api/admin-auth/sign-in";
        return;
      }
      // Distinguish a failed detail load from a genuinely empty assignment
      // list. Without this, a transient outage renders "None" current
      // assignments and (because assignedIds is then empty) offers
      // already-assigned customers as add candidates. Flag the error and gate
      // the add control on it.
      setManageDetail(null);
      setManageDetailError(true);
    } finally {
      setManageDetailLoading(false);
    }
  }, []);

  const openManage = (analyst: Analyst) => {
    setManageTarget(analyst);
    setManageDetail(null);
    setAddCustomerId("");
    setManageOpen(true);
    void fetchManageDetail(analyst.accountId);
  };

  const handleAddAssignment = async () => {
    if (!manageTarget || !addCustomerId) return;
    setManageActionLoading(true);
    try {
      await adminFetch(
        `/api/admin/analysts/${manageTarget.accountId}/assignments`,
        {
          method: "POST",
          body: JSON.stringify({ customerId: addCustomerId }),
        },
      );
      setAddCustomerId("");
      showToast(t("assignmentAddSuccess"), "success");
      await Promise.all([
        fetchManageDetail(manageTarget.accountId),
        fetchAnalysts(),
      ]);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        window.location.href = "/api/admin-auth/sign-in";
        return;
      }
      showToast(t("actionError"), "error");
    } finally {
      setManageActionLoading(false);
    }
  };

  const handleRemoveAssignment = async (customerId: string) => {
    if (!manageTarget) return;
    setManageActionLoading(true);
    try {
      await adminFetch(
        `/api/admin/analysts/${manageTarget.accountId}/assignments/${customerId}`,
        { method: "DELETE" },
      );
      showToast(t("assignmentRemoveSuccess"), "success");
      await Promise.all([
        fetchManageDetail(manageTarget.accountId),
        fetchAnalysts(),
      ]);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        window.location.href = "/api/admin-auth/sign-in";
        return;
      }
      showToast(t("actionError"), "error");
    } finally {
      setManageActionLoading(false);
    }
  };

  // Active customers not already assigned to the analyst being managed.
  const assignedIds = new Set(
    manageDetail?.assignedCustomers.map((c) => c.id) ?? [],
  );
  const assignableCustomers = activeCustomers.filter(
    (c) => !assignedIds.has(c.id),
  );

  // -----------------------------------------------------------------------
  // Render
  // -----------------------------------------------------------------------

  const toggle = (
    list: string[],
    setter: (next: string[]) => void,
    id: string,
  ) => {
    setter(list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);
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

      {/* Warnings for picker dependencies: 403 (permission) vs load failure. */}
      {customersForbidden && (
        <div className="rounded-lg border border-destructive/50 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {t("customersUnavailable")}
        </div>
      )}
      {customersLoadError && (
        <div className="rounded-lg border border-destructive/50 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {t("customersLoadFailed")}
        </div>
      )}
      {accountsForbidden && (
        <div className="rounded-lg border border-destructive/50 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {t("accountsUnavailable")}
        </div>
      )}
      {accountsLoadError && (
        <div className="rounded-lg border border-destructive/50 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {t("accountsLoadFailed")}
        </div>
      )}

      {/* Toolbar */}
      <div className="flex justify-end gap-2">
        <Button
          type="button"
          variant="outline"
          onClick={openDesignate}
          disabled={loading || customersUnavailable || accountsUnavailable}
        >
          {t("designate")}
        </Button>
        <Button
          type="button"
          onClick={openInvite}
          disabled={loading || customersUnavailable}
        >
          {t("invite")}
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

      {/* Analyst table */}
      {!loading &&
        !error &&
        (analysts.length === 0 ? (
          <div className="flex items-center justify-center py-12">
            <p className="text-sm text-muted-foreground">{t("noResults")}</p>
          </div>
        ) : (
          <div className="rounded-md border border-border bg-card">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("displayName")}</TableHead>
                  <TableHead>{t("email")}</TableHead>
                  <TableHead>{t("assignedCustomers")}</TableHead>
                  <TableHead>{t("eligibility")}</TableHead>
                  <TableHead>{t("lastSignIn")}</TableHead>
                  <TableHead>{t("actions")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {analysts.map((analyst) => (
                  <TableRow key={analyst.accountId}>
                    <TableCell>
                      <span className="font-medium">{analyst.displayName}</span>
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {analyst.email ?? t("noEmail")}
                    </TableCell>
                    <TableCell>
                      {analyst.assignedCustomerIds.length === 0 ? (
                        <span className="text-sm text-muted-foreground">
                          {t("noAssignments")}
                        </span>
                      ) : (
                        <div className="flex flex-wrap gap-1">
                          {analyst.assignedCustomerIds.map((id) => (
                            <Badge key={id} variant="secondary">
                              {customerNameById.get(id) ?? id}
                            </Badge>
                          ))}
                        </div>
                      )}
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant={
                          analyst.analystEligible ? "default" : "secondary"
                        }
                      >
                        {analyst.analystEligible ? t("eligible") : t("revoked")}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {analyst.lastSignInAt ? (
                        <Timestamp at={analyst.lastSignInAt} />
                      ) : (
                        t("never")
                      )}
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => openManage(analyst)}
                          disabled={customersUnavailable}
                        >
                          {t("manage")}
                        </Button>
                        {analyst.analystEligible && (
                          <Button
                            type="button"
                            variant="destructive"
                            size="sm"
                            onClick={() => openRevoke(analyst)}
                          >
                            {t("revoke")}
                          </Button>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        ))}

      {/* Pending invitations */}
      {!loading && !error && (
        <div className="space-y-3">
          <h2 className="text-lg font-semibold text-foreground">
            {t("pendingTitle")}
          </h2>
          {invitationsLoadError ? (
            <p className="text-sm text-destructive">{t("pendingLoadFailed")}</p>
          ) : invitations.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {t("noPendingInvitations")}
            </p>
          ) : (
            <div className="rounded-md border border-border bg-card">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("pendingEmail")}</TableHead>
                    <TableHead>{t("pendingCustomers")}</TableHead>
                    <TableHead>{t("pendingExpires")}</TableHead>
                    <TableHead>{t("actions")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {invitations.map((invitation) => (
                    <TableRow key={invitation.id}>
                      <TableCell className="font-medium">
                        {invitation.email}
                      </TableCell>
                      <TableCell>
                        {invitation.customerIds.length === 0 ? (
                          <span className="text-sm text-muted-foreground">
                            {t("noAssignments")}
                          </span>
                        ) : (
                          <div className="flex flex-wrap gap-1">
                            {invitation.customerIds.map((id) => (
                              <Badge key={id} variant="secondary">
                                {customerNameById.get(id) ?? id}
                              </Badge>
                            ))}
                          </div>
                        )}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        <Timestamp at={invitation.expiresAt} />
                      </TableCell>
                      <TableCell>
                        <Button
                          type="button"
                          variant="destructive"
                          size="sm"
                          onClick={() => openRevokeInvite(invitation)}
                        >
                          {t("revokeInvitation")}
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

      {/* Invite dialog */}
      <Dialog open={inviteOpen} onOpenChange={setInviteOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("inviteTitle")}</DialogTitle>
            <DialogDescription>{t("inviteDescription")}</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <label
                htmlFor="invite-email"
                className="text-sm font-medium text-foreground"
              >
                {t("emailLabel")}
              </label>
              <Input
                id="invite-email"
                type="email"
                value={inviteEmail}
                onChange={(e) => setInviteEmail(e.target.value)}
                disabled={inviteLoading}
              />
            </div>
            <div className="space-y-2">
              <span className="text-sm font-medium text-foreground">
                {t("customersLabel")}
              </span>
              <CustomerMultiSelect
                customers={activeCustomers}
                selected={inviteCustomerIds}
                onToggle={(id) =>
                  toggle(inviteCustomerIds, setInviteCustomerIds, id)
                }
                disabled={inviteLoading}
                emptyText={t("customersPickerEmpty")}
              />
            </div>
          </div>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline" disabled={inviteLoading}>
                {tCommon("cancel")}
              </Button>
            </DialogClose>
            <Button
              type="button"
              disabled={
                inviteLoading ||
                !inviteEmail.trim() ||
                inviteCustomerIds.length === 0
              }
              onClick={handleInvite}
            >
              {inviteLoading ? tCommon("loading") : t("send")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Designate dialog */}
      <Dialog open={designateOpen} onOpenChange={setDesignateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("designateTitle")}</DialogTitle>
            <DialogDescription>{t("designateDescription")}</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <label
                htmlFor="designate-search"
                className="text-sm font-medium text-foreground"
              >
                {t("accountLabel")}
              </label>
              <Input
                id="designate-search"
                value={designateSearch}
                onChange={(e) => handleDesignateSearchChange(e.target.value)}
                placeholder={t("accountSearchPlaceholder")}
                disabled={designateLoading}
              />
              <div className="max-h-40 space-y-1 overflow-y-auto rounded-lg border border-border p-2">
                {matchingAccounts.length === 0 ? (
                  <p className="px-2 py-1 text-sm text-muted-foreground">
                    {t("noMatchingAccounts")}
                  </p>
                ) : (
                  matchingAccounts.map((account) => (
                    <button
                      key={account.id}
                      type="button"
                      onClick={() => setDesignateAccountId(account.id)}
                      disabled={designateLoading}
                      className={`flex w-full flex-col rounded px-2 py-1 text-left text-sm hover:bg-accent ${
                        designateAccountId === account.id ? "bg-accent" : ""
                      }`}
                    >
                      <span className="text-foreground">
                        {account.displayName || account.username}
                      </span>
                      {account.email && (
                        <span className="text-xs text-muted-foreground">
                          {account.email}
                        </span>
                      )}
                    </button>
                  ))
                )}
              </div>
              <p className="text-sm text-muted-foreground">
                {selectedDesignateAccount
                  ? t("designateSelectedAccount", {
                      name:
                        selectedDesignateAccount.displayName ||
                        selectedDesignateAccount.username,
                    })
                  : t("designateNoSelection")}
              </p>
            </div>
            <div className="space-y-2">
              <span className="text-sm font-medium text-foreground">
                {t("customersLabel")}
              </span>
              <CustomerMultiSelect
                customers={activeCustomers}
                selected={designateCustomerIds}
                onToggle={(id) =>
                  toggle(designateCustomerIds, setDesignateCustomerIds, id)
                }
                disabled={designateLoading}
                emptyText={t("customersPickerEmpty")}
              />
            </div>
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
                !designateAccountId ||
                designateCustomerIds.length === 0
              }
              onClick={handleDesignate}
            >
              {designateLoading ? tCommon("loading") : t("designate")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Revoke analyst dialog */}
      <Dialog open={revokeOpen} onOpenChange={setRevokeOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("revokeTitle")}</DialogTitle>
            <DialogDescription>
              {t("revokeConfirm", { name: revokeTarget?.displayName ?? "" })}
            </DialogDescription>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            {t("revokeAssignmentsNote")}
          </p>
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

      {/* Revoke invitation dialog */}
      <Dialog open={revokeInviteOpen} onOpenChange={setRevokeInviteOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("revokeInvitationTitle")}</DialogTitle>
            <DialogDescription>
              {t("revokeInvitationConfirm", {
                email: revokeInviteTarget?.email ?? "",
              })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose asChild>
              <Button
                type="button"
                variant="outline"
                disabled={revokeInviteLoading}
              >
                {tCommon("cancel")}
              </Button>
            </DialogClose>
            <Button
              type="button"
              variant="destructive"
              disabled={revokeInviteLoading}
              onClick={handleRevokeInvite}
            >
              {revokeInviteLoading ? tCommon("loading") : t("revokeInvitation")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Manage assignments dialog */}
      <Dialog open={manageOpen} onOpenChange={setManageOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("manageTitle")}</DialogTitle>
            <DialogDescription>
              {t("manageDescription", {
                name: manageTarget?.displayName ?? "",
              })}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <span className="text-sm font-medium text-foreground">
                {t("currentAssignments")}
              </span>
              {manageDetailLoading ? (
                <p className="text-sm text-muted-foreground">
                  {tCommon("loading")}
                </p>
              ) : manageDetailError ? (
                <p className="text-sm text-destructive">
                  {t("assignmentsLoadFailed")}
                </p>
              ) : !manageDetail ||
                manageDetail.assignedCustomers.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  {t("noAssignments")}
                </p>
              ) : (
                <div className="space-y-1">
                  {manageDetail.assignedCustomers.map((c) => (
                    <div
                      key={c.id}
                      className="flex items-center justify-between rounded border border-border px-3 py-1.5"
                    >
                      <span className="text-sm text-foreground">{c.name}</span>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={manageActionLoading}
                        onClick={() => handleRemoveAssignment(c.id)}
                      >
                        {t("remove")}
                      </Button>
                    </div>
                  ))}
                </div>
              )}
            </div>
            <div className="space-y-2">
              <span className="text-sm font-medium text-foreground">
                {t("addAssignment")}
              </span>
              {manageDetailError ? (
                // Assignment data failed to load, so we can't know which
                // customers are already assigned. Disable adding rather than
                // risk offering an already-assigned customer.
                <p className="text-sm text-muted-foreground">
                  {t("addAssignmentUnavailable")}
                </p>
              ) : assignableCustomers.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  {t("noActiveCustomers")}
                </p>
              ) : (
                <div className="flex items-center gap-2">
                  <Select
                    value={addCustomerId}
                    onChange={(e) => setAddCustomerId(e.target.value)}
                    disabled={manageActionLoading || manageDetailLoading}
                  >
                    <option value="">{t("selectCustomer")}</option>
                    {assignableCustomers.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </Select>
                  <Button
                    type="button"
                    disabled={
                      manageActionLoading ||
                      manageDetailLoading ||
                      !addCustomerId
                    }
                    onClick={handleAddAssignment}
                  >
                    {t("add")}
                  </Button>
                </div>
              )}
            </div>
          </div>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline">
                {tCommon("back")}
              </Button>
            </DialogClose>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
