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

import { DATE_TIME_FORMAT, type PendingInvitation } from "./types";

interface PendingInvitationsProps {
  invitations: PendingInvitation[];
  onRevoke: (id: string, email: string) => Promise<void>;
}

export function PendingInvitations({
  invitations,
  onRevoke,
}: PendingInvitationsProps) {
  const t = useTranslations("members");
  const tCommon = useTranslations("common");
  const format = useFormatter();

  const [revokeTarget, setRevokeTarget] = useState<PendingInvitation | null>(
    null,
  );
  const [acting, setActing] = useState(false);

  const handleRevokeConfirm = async () => {
    if (!revokeTarget) return;
    setActing(true);
    try {
      await onRevoke(revokeTarget.id, revokeTarget.email);
    } finally {
      setActing(false);
      setRevokeTarget(null);
    }
  };

  if (invitations.length === 0) {
    return <p className="text-sm text-muted-foreground">{t("pendingEmpty")}</p>;
  }

  return (
    <>
      <div className="overflow-hidden rounded-md border border-border">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border bg-muted/50">
              <th className="px-3 py-3 text-left font-medium text-muted-foreground">
                {t("email")}
              </th>
              <th className="px-3 py-3 text-left font-medium text-muted-foreground">
                {t("role")}
              </th>
              <th className="px-3 py-3 text-left font-medium text-muted-foreground">
                {t("expiresAt", { date: "" }).trim()}
              </th>
              <th className="px-3 py-3 text-right font-medium text-muted-foreground">
                <span className="sr-only">{t("actions")}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {invitations.map((inv) => (
              <tr
                key={inv.id}
                className="border-b border-border last:border-b-0"
              >
                <td className="px-3 py-3.5 text-foreground">{inv.email}</td>
                <td className="px-3 py-3.5">
                  <Badge variant="secondary">
                    {inv.role === "Manager" ? t("roleManager") : t("roleUser")}
                  </Badge>
                </td>
                <td className="px-3 py-3.5 text-muted-foreground">
                  {format.dateTime(new Date(inv.expiresAt), DATE_TIME_FORMAT)}
                </td>
                <td className="px-3 py-3.5 text-right">
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    className="text-destructive hover:text-destructive"
                    onClick={() => setRevokeTarget(inv)}
                  >
                    {t("revoke")}
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <Dialog
        open={revokeTarget !== null}
        onOpenChange={(open) => {
          if (!open) setRevokeTarget(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("revokeTitle")}</DialogTitle>
            <DialogDescription>
              {revokeTarget &&
                t("revokeConfirm", { email: revokeTarget.email })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={acting}
              onClick={() => setRevokeTarget(null)}
            >
              {tCommon("cancel")}
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={acting}
              onClick={handleRevokeConfirm}
            >
              {t("revoke")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
