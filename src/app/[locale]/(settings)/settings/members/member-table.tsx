"use client";

import { useFormatter, useTranslations } from "next-intl";
import { useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Select } from "@/components/ui/select";

import { DATE_TIME_FORMAT, type Member, type Role } from "./types";

interface MemberTableProps {
  members: Member[];
  roles: Role[];
  currentAccountId: string;
  currentRoleId: number | null;
  managerCount: number;
  isManager: boolean;
  onRemove: (accountId: string) => Promise<void>;
  onChangeRole: (accountId: string, roleId: number) => Promise<void>;
}

export function MemberTable({
  members,
  roles,
  currentAccountId,
  managerCount,
  isManager,
  onRemove,
  onChangeRole,
}: MemberTableProps) {
  const t = useTranslations("members");
  const tCommon = useTranslations("common");
  const format = useFormatter();

  const [removeTarget, setRemoveTarget] = useState<Member | null>(null);
  const [changeRoleTarget, setChangeRoleTarget] = useState<Member | null>(null);
  const [selectedRoleId, setSelectedRoleId] = useState<number | null>(null);
  const [acting, setActing] = useState(false);

  const isLastManager = (member: Member) =>
    member.roleName === "Manager" && managerCount <= 1;

  const handleRemoveConfirm = async () => {
    if (!removeTarget) return;
    setActing(true);
    try {
      await onRemove(removeTarget.accountId);
    } finally {
      setActing(false);
      setRemoveTarget(null);
    }
  };

  const handleChangeRoleConfirm = async () => {
    if (!changeRoleTarget || selectedRoleId === null) return;
    setActing(true);
    try {
      await onChangeRole(changeRoleTarget.accountId, selectedRoleId);
    } finally {
      setActing(false);
      setChangeRoleTarget(null);
      setSelectedRoleId(null);
    }
  };

  const otherRole = (member: Member) =>
    roles.find((r) => r.name !== member.roleName);

  return (
    <>
      <div className="overflow-hidden rounded-lg border border-border">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border bg-muted/50">
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">
                {t("name")}
              </th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">
                {t("email")}
              </th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">
                {t("role")}
              </th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">
                {t("lastSignIn")}
              </th>
              {isManager && (
                <th className="px-4 py-3 text-right font-medium text-muted-foreground">
                  <span className="sr-only">Actions</span>
                </th>
              )}
            </tr>
          </thead>
          <tbody>
            {members.map((member) => (
              <tr
                key={member.accountId}
                className="border-b border-border last:border-b-0"
              >
                <td className="px-4 py-3 font-medium text-foreground">
                  {member.displayName}
                  {member.accountId === currentAccountId && (
                    <span className="ml-1 text-xs text-muted-foreground">
                      {t("youLabel")}
                    </span>
                  )}
                </td>
                <td className="px-4 py-3 text-muted-foreground">
                  {member.email ?? "—"}
                </td>
                <td className="px-4 py-3">
                  <span className="inline-flex items-center gap-1.5">
                    {member.roleName === "Manager"
                      ? t("roleManager")
                      : t("roleUser")}
                    {isLastManager(member) && (
                      <Badge variant="warning" title={t("lastManagerTooltip")}>
                        {t("lastManager")}
                      </Badge>
                    )}
                  </span>
                </td>
                <td className="px-4 py-3 text-muted-foreground">
                  {member.lastSignInAt
                    ? format.dateTime(
                        new Date(member.lastSignInAt),
                        DATE_TIME_FORMAT,
                      )
                    : t("never")}
                </td>
                {isManager && (
                  <td className="px-4 py-3 text-right">
                    <div className="flex items-center justify-end gap-1">
                      {otherRole(member) && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="xs"
                          disabled={isLastManager(member)}
                          title={
                            isLastManager(member)
                              ? t("lastManagerTooltip")
                              : undefined
                          }
                          onClick={() => {
                            const target = otherRole(member);
                            if (target) {
                              setChangeRoleTarget(member);
                              setSelectedRoleId(target.id);
                            }
                          }}
                        >
                          {t("changeRole")}
                        </Button>
                      )}
                      <Button
                        type="button"
                        variant="ghost"
                        size="xs"
                        className="text-destructive hover:text-destructive"
                        disabled={isLastManager(member)}
                        title={
                          isLastManager(member)
                            ? t("lastManagerTooltip")
                            : undefined
                        }
                        onClick={() => setRemoveTarget(member)}
                      >
                        {t("removeMember")}
                      </Button>
                    </div>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Remove confirmation dialog */}
      <Dialog
        open={removeTarget !== null}
        onOpenChange={(open) => {
          if (!open) setRemoveTarget(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("removeMemberTitle")}</DialogTitle>
            <DialogDescription>
              {removeTarget &&
                t("removeMemberConfirm", {
                  name: removeTarget.displayName,
                })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={acting}
              onClick={() => setRemoveTarget(null)}
            >
              {tCommon("cancel")}
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={acting}
              onClick={handleRemoveConfirm}
            >
              {t("removeMember")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Change role confirmation dialog */}
      <Dialog
        open={changeRoleTarget !== null}
        onOpenChange={(open) => {
          if (!open) {
            setChangeRoleTarget(null);
            setSelectedRoleId(null);
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("changeRole")}</DialogTitle>
            <DialogDescription>
              {changeRoleTarget &&
                selectedRoleId !== null &&
                t("changeRoleConfirm", {
                  name: changeRoleTarget.displayName,
                  role:
                    roles.find((r) => r.id === selectedRoleId)?.name ===
                    "Manager"
                      ? t("roleManager")
                      : t("roleUser"),
                })}
            </DialogDescription>
          </DialogHeader>
          {roles.length > 2 && changeRoleTarget && (
            <Select
              value={String(selectedRoleId ?? "")}
              onChange={(e) => setSelectedRoleId(Number(e.target.value))}
            >
              {roles
                .filter((r) => r.id !== changeRoleTarget.roleId)
                .map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name}
                  </option>
                ))}
            </Select>
          )}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={acting}
              onClick={() => {
                setChangeRoleTarget(null);
                setSelectedRoleId(null);
              }}
            >
              {tCommon("cancel")}
            </Button>
            <Button
              type="button"
              disabled={acting}
              onClick={handleChangeRoleConfirm}
            >
              {t("changeRole")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
