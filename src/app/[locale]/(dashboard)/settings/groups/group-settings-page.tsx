"use client";

import { Boxes } from "lucide-react";
import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import { useCallback, useEffect, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { useCustomerContext } from "@/hooks/use-customer-context";
import { ApiError, apiFetch } from "@/lib/api/client";
import type { ManagedGroupSummary } from "@/lib/api/types";

import { CreateGroupDialog } from "./create-group-dialog";

/** Map a group data-DB provisioning state to a status badge variant. */
function statusVariant(
  status: string,
): "default" | "secondary" | "warning" | "destructive" {
  if (status === "active") return "secondary";
  if (status === "failed") return "destructive";
  return "warning";
}

export function GroupSettingsPage() {
  const t = useTranslations("groupSettings");
  const tCommon = useTranslations("common");
  const locale = useLocale();
  const { me, isBridgeSession, loading: contextLoading } = useCustomerContext();

  const [groups, setGroups] = useState<ManagedGroupSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Localize a known provisioning status; the narrowing keeps the dynamic
  // message key within the typed key union.
  const statusLabel = (status: string) =>
    status === "active" || status === "failed" || status === "provisioning"
      ? t(`dbStatus.${status}`)
      : status;

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await apiFetch<{ groups: ManagedGroupSummary[] }>(
        "/api/groups",
      );
      setGroups(data.groups);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        window.location.href = "/api/auth/sign-in";
        return;
      }
      setError(t("listError"));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void reload();
  }, [reload]);

  // A management surface, never offered under a bridge (the API returns an
  // empty list anyway). Surface the forbidden state rather than an empty table.
  if (isBridgeSession) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-sm text-destructive">{tCommon("forbidden")}</p>
      </div>
    );
  }

  if (loading || contextLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-sm text-muted-foreground">{tCommon("loading")}</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-sm text-destructive">{error}</p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-4xl px-4 py-8 sm:px-6">
      <div className="mb-8 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-foreground">{t("title")}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {t("description")}
          </p>
        </div>
        <CreateGroupDialog onCreated={reload} />
      </div>

      {groups.length === 0 ? (
        <div className="rounded-md border border-dashed border-border p-10 text-center">
          <Boxes className="mx-auto h-8 w-8 text-muted-foreground" />
          <p className="mt-3 text-sm text-muted-foreground">{t("empty")}</p>
        </div>
      ) : (
        <ul className="divide-y divide-border rounded-md border border-border">
          {groups.map((g) => {
            const isOwner = me?.accountId === g.ownerId;
            return (
              <li key={g.id}>
                <Link
                  href={`/${locale}/settings/groups/${g.id}`}
                  className="flex items-center justify-between gap-4 px-4 py-3 transition-colors hover:bg-accent"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="truncate font-medium text-foreground">
                        {g.name}
                      </span>
                      {isOwner && (
                        <Badge variant="outline">{t("ownerBadge")}</Badge>
                      )}
                    </div>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {t("memberCount", { count: g.memberCount })}
                    </p>
                  </div>
                  <Badge variant={statusVariant(g.databaseStatus)}>
                    {statusLabel(g.databaseStatus)}
                  </Badge>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
