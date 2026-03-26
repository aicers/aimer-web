"use client";

import { useTranslations } from "next-intl";
import { useCallback, useEffect, useState } from "react";

import { ApiError, apiFetch } from "@/lib/api/client";

import { InviteDialog } from "./invite-dialog";
import { MemberTable } from "./member-table";
import { PendingInvitations } from "./pending-invitations";
import type { Member, MeResponse, PendingInvitation, Role } from "./types";

export function MembersPage() {
  const t = useTranslations("members");
  const tCommon = useTranslations("common");

  const [me, setMe] = useState<MeResponse | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [invitations, setInvitations] = useState<PendingInvitation[]>([]);
  const [roles, setRoles] = useState<Role[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<{
    message: string;
    type: "success" | "error";
  } | null>(null);

  // TODO(#38): Replace memberships[0] with customer selector from dashboard layout
  const customerId = me?.memberships[0]?.customerId ?? null;
  const myRoleId = me?.memberships[0]?.roleId ?? null;
  const isManager = me?.memberships[0]?.roleName === "Manager";

  const showToast = useCallback(
    (message: string, type: "success" | "error") => {
      setToast({ message, type });
      setTimeout(() => setToast(null), 4000);
    },
    [],
  );

  const fetchData = useCallback(async () => {
    try {
      const meData = await apiFetch<MeResponse>("/api/auth/me");
      setMe(meData);

      const cid = meData.memberships[0]?.customerId;
      if (!cid) {
        setError("No customer access");
        setLoading(false);
        return;
      }

      const [memberData, invData, rolesData] = await Promise.all([
        apiFetch<{ members: Member[] }>(`/api/members?customer_id=${cid}`),
        apiFetch<{ invitations: PendingInvitation[] }>(
          `/api/invitations?customer_id=${cid}`,
        ),
        apiFetch<{ roles: Role[] }>("/api/roles"),
      ]);

      setMembers(memberData.members);
      setInvitations(invData.invitations);
      setRoles(rolesData.roles);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        window.location.href = "/api/auth/sign-in";
        return;
      }
      setError(t("actionError"));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const managerCount = members.filter((m) => m.roleName === "Manager").length;

  function handleMemberError(err: unknown) {
    if (
      err instanceof ApiError &&
      err.message === "last_manager_cannot_be_removed"
    ) {
      showToast(t("lastManagerError"), "error");
    } else {
      showToast(t("actionError"), "error");
    }
  }

  const handleRemoveMember = async (accountId: string) => {
    if (!customerId) return;
    try {
      await apiFetch(`/api/members/${accountId}?customer_id=${customerId}`, {
        method: "DELETE",
      });
      showToast(t("actionSuccess"), "success");
      await fetchData();
    } catch (err) {
      handleMemberError(err);
    }
  };

  const handleChangeRole = async (accountId: string, roleId: number) => {
    if (!customerId) return;
    try {
      await apiFetch(`/api/members/${accountId}`, {
        method: "PATCH",
        body: JSON.stringify({ customerId, roleId }),
      });
      showToast(t("actionSuccess"), "success");
      await fetchData();
    } catch (err) {
      handleMemberError(err);
    }
  };

  const handleInvite = async (email: string, role: string) => {
    if (!customerId) return;
    try {
      await apiFetch("/api/invitations", {
        method: "POST",
        body: JSON.stringify({ customerId, email, role }),
      });
      showToast(t("inviteSuccess", { email }), "success");
      await fetchData();
    } catch (err) {
      if (err instanceof ApiError && err.message === "already_member") {
        showToast(t("inviteAlreadyMember"), "error");
      } else {
        showToast(t("actionError"), "error");
      }
      throw err;
    }
  };

  const handleRevokeInvitation = async (id: string, email: string) => {
    try {
      await apiFetch(`/api/invitations/${id}`, { method: "DELETE" });
      showToast(t("revokeSuccess", { email }), "success");
      await fetchData();
    } catch {
      showToast(t("actionError"), "error");
    }
  };

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <p className="text-sm text-muted-foreground">{tCommon("loading")}</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <p className="text-sm text-destructive">{error}</p>
      </div>
    );
  }

  return (
    <main id="main-content" className="mx-auto max-w-4xl px-4 py-8 sm:px-6">
      {toast && (
        <div
          role="status"
          className={`fixed top-4 right-4 z-50 rounded-md px-4 py-3 text-sm shadow-lg ${
            toast.type === "success"
              ? "bg-card text-foreground border border-border"
              : "bg-destructive/10 text-destructive border border-destructive/20"
          }`}
        >
          {toast.message}
        </div>
      )}

      <div className="mb-8">
        <h1 className="text-2xl font-semibold text-foreground">{t("title")}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{t("description")}</p>
      </div>

      <div className="space-y-8">
        <section>
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-lg font-medium text-foreground">
              {t("title")}
            </h2>
            {isManager && <InviteDialog onInvite={handleInvite} />}
          </div>
          <MemberTable
            members={members}
            roles={roles}
            currentAccountId={me?.accountId ?? ""}
            currentRoleId={myRoleId}
            managerCount={managerCount}
            isManager={isManager}
            onRemove={handleRemoveMember}
            onChangeRole={handleChangeRole}
          />
        </section>

        {isManager && (
          <section>
            <h2 className="mb-4 text-lg font-medium text-foreground">
              {t("pendingInvitations")}
            </h2>
            <PendingInvitations
              invitations={invitations}
              onRevoke={handleRevokeInvitation}
            />
          </section>
        )}
      </div>
    </main>
  );
}
