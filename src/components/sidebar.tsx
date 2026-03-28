"use client";

import { Home, Lock, Settings, Users } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { Select } from "@/components/ui/select";
import { useCustomerContext } from "@/hooks/use-customer-context";
import { usePermissions } from "@/hooks/use-permissions";
import { cn } from "@/lib/utils";

export function Sidebar() {
  const t = useTranslations("nav");
  const tSidebar = useTranslations("sidebar");
  const locale = useLocale();
  const pathname = usePathname();
  const permissions = usePermissions();
  const {
    customers,
    selectedCustomerId,
    setSelectedCustomerId,
    environments,
    selectedEnvironmentId,
    setSelectedEnvironmentId,
    isBridgeSession,
  } = useCustomerContext();

  const navItems = [
    { href: `/${locale}`, label: t("dashboard"), icon: Home, visible: true },
    {
      href: `/${locale}/settings/members`,
      label: t("members"),
      icon: Users,
      visible: permissions.canViewMembers,
    },
    {
      href: `/${locale}/settings/customer`,
      label: t("customerSettings"),
      icon: Settings,
      visible: permissions.canViewCustomerSettings,
    },
  ];

  return (
    <aside className="flex h-full w-60 flex-col border-r border-border bg-background">
      <div className="border-b border-border p-4">
        <div className="mb-3">
          <label
            htmlFor="customer-select"
            className="mb-1 block text-xs font-medium text-muted-foreground"
          >
            {isBridgeSession && <Lock className="mr-1 inline-block h-3 w-3" />}
            {tSidebar("selectCustomer")}
          </label>
          <Select
            id="customer-select"
            value={selectedCustomerId ?? ""}
            onChange={(e) => setSelectedCustomerId(e.target.value)}
            disabled={isBridgeSession}
            className="w-full"
          >
            {customers.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
        </div>

        <div>
          <label
            htmlFor="environment-select"
            className="mb-1 block text-xs font-medium text-muted-foreground"
          >
            {isBridgeSession && <Lock className="mr-1 inline-block h-3 w-3" />}
            {tSidebar("selectEnvironment")}
          </label>
          <Select
            id="environment-select"
            value={selectedEnvironmentId ?? ""}
            onChange={(e) => setSelectedEnvironmentId(e.target.value)}
            disabled={isBridgeSession || environments.length === 0}
            className="w-full"
          >
            {environments.map((e) => (
              <option key={e.aiceId} value={e.aiceId}>
                {e.name}
              </option>
            ))}
          </Select>
        </div>

        {isBridgeSession && (
          <p className="mt-2 text-xs text-muted-foreground">
            <Lock className="mr-1 inline-block h-3 w-3" />
            {tSidebar("bridgeLocked")}
          </p>
        )}
      </div>

      <nav className="flex-1 p-2">
        <ul className="space-y-1">
          {navItems
            .filter((item) => item.visible)
            .map((item) => {
              const isActive = pathname === item.href;
              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    className={cn(
                      "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors",
                      isActive
                        ? "bg-accent text-accent-foreground"
                        : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
                    )}
                  >
                    <item.icon className="h-4 w-4" />
                    {item.label}
                  </Link>
                </li>
              );
            })}
        </ul>
      </nav>
    </aside>
  );
}
