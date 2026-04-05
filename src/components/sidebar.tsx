"use client";

import {
  FileText,
  Home,
  LayoutDashboard,
  Lock,
  Menu,
  Search,
  Settings,
  Shield,
  Users,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { useCallback, useEffect, useState } from "react";

import { Select } from "@/components/ui/select";
import { Sheet, SheetContent, SheetTrigger } from "@/components/ui/sheet";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useCustomerContext } from "@/hooks/use-customer-context";
import { usePermissions } from "@/hooks/use-permissions";
import { cn } from "@/lib/utils";

import {
  SIDEBAR_WIDTH_COLLAPSED,
  SIDEBAR_WIDTH_EXPANDED,
} from "./layout-constants";

const SIDEBAR_COLLAPSED_KEY = "sidebar-collapsed";

export interface NavItem {
  href: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  visible?: boolean;
  exact?: boolean;
}

export function useSidebarCollapsed() {
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    const stored = localStorage.getItem(SIDEBAR_COLLAPSED_KEY);
    if (stored === "true") setCollapsed(true);
  }, []);

  const toggle = useCallback(() => {
    setCollapsed((prev) => {
      const next = !prev;
      localStorage.setItem(SIDEBAR_COLLAPSED_KEY, String(next));
      return next;
    });
  }, []);

  return { collapsed, toggle };
}

function useNavItems(): NavItem[] {
  const t = useTranslations("nav");
  const locale = useLocale();
  const permissions = usePermissions();

  return [
    { href: `/${locale}`, label: t("home"), icon: Home, exact: true },
    {
      href: `/${locale}/events`,
      label: t("events"),
      icon: Shield,
    },
    {
      href: `/${locale}/analysis`,
      label: t("analysis"),
      icon: Search,
    },
    {
      href: `/${locale}/reports`,
      label: t("reports"),
      icon: FileText,
    },
    {
      href: `/${locale}/dashboard`,
      label: t("dashboard"),
      icon: LayoutDashboard,
    },
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
}

function CustomerSelector({ collapsed }: { collapsed: boolean }) {
  const tSidebar = useTranslations("sidebar");
  const {
    customers,
    selectedCustomerId,
    setSelectedCustomerId,
    environments,
    selectedEnvironmentId,
    setSelectedEnvironmentId,
    isBridgeSession,
  } = useCustomerContext();

  if (collapsed) return null;

  return (
    <div className="border-b border-[var(--sidebar-border)] p-3">
      <div className="mb-2">
        <label
          htmlFor="customer-select"
          className="mb-1 flex items-center text-xs font-medium text-[var(--sidebar-muted)]"
        >
          {isBridgeSession && <Lock className="mr-1 h-3 w-3" />}
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
          className="mb-1 flex items-center text-xs font-medium text-[var(--sidebar-muted)]"
        >
          {isBridgeSession && <Lock className="mr-1 h-3 w-3" />}
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
        <p className="mt-2 flex items-center text-xs text-[var(--sidebar-muted)]">
          <Lock className="mr-1 h-3 w-3" />
          {tSidebar("bridgeLocked")}
        </p>
      )}
    </div>
  );
}

export function NavList({
  items,
  collapsed,
  ariaLabel = "Main",
  onNavigate,
}: {
  items: NavItem[];
  collapsed: boolean;
  ariaLabel?: string;
  onNavigate?: (() => void) | null;
}) {
  const pathname = usePathname();

  const visible = items.filter((item) => item.visible !== false);

  return (
    <nav aria-label={ariaLabel} className="flex-1 overflow-y-auto p-2">
      <ul className="space-y-1">
        {visible.map((item) => {
          const isActive = item.exact
            ? pathname === item.href
            : pathname.startsWith(item.href);

          const link = (
            <Link
              href={item.href}
              onClick={onNavigate ?? undefined}
              aria-current={isActive ? "page" : undefined}
              className={cn(
                "flex items-center rounded-md font-medium transition-colors",
                collapsed
                  ? "flex-col justify-center gap-0.5 px-1 py-2 text-[10px]"
                  : "gap-3 px-3 py-2 text-sm",
                isActive
                  ? "bg-[var(--sidebar-active)] text-white"
                  : "text-[var(--sidebar-muted)] hover:bg-[var(--sidebar-account-bg)] hover:text-[var(--sidebar-fg)]",
              )}
            >
              <item.icon className="h-4 w-4 shrink-0" />
              {collapsed ? (
                <span className="truncate w-full text-center">
                  {item.label}
                </span>
              ) : (
                item.label
              )}
            </Link>
          );

          if (collapsed) {
            return (
              <li key={item.href}>
                <Tooltip>
                  <TooltipTrigger asChild>{link}</TooltipTrigger>
                  <TooltipContent side="right">{item.label}</TooltipContent>
                </Tooltip>
              </li>
            );
          }

          return <li key={item.href}>{link}</li>;
        })}
      </ul>
    </nav>
  );
}

function SidebarContent({
  collapsed,
  onNavigate,
}: {
  collapsed: boolean;
  onNavigate?: (() => void) | null;
}) {
  const navItems = useNavItems();

  return (
    <>
      <CustomerSelector collapsed={collapsed} />
      <NavList items={navItems} collapsed={collapsed} onNavigate={onNavigate} />
    </>
  );
}

export function SidebarShell({
  collapsed,
  children,
}: {
  collapsed: boolean;
  children: React.ReactNode;
}) {
  return (
    <TooltipProvider>
      <aside
        className={cn(
          "hidden h-full flex-col border-r border-[var(--sidebar-border)] bg-[var(--sidebar-bg)] transition-[width] duration-200 md:flex",
          collapsed ? SIDEBAR_WIDTH_COLLAPSED : SIDEBAR_WIDTH_EXPANDED,
        )}
      >
        {children}
      </aside>
    </TooltipProvider>
  );
}

export function Sidebar({ collapsed }: { collapsed: boolean }) {
  return (
    <SidebarShell collapsed={collapsed}>
      <SidebarContent collapsed={collapsed} />
    </SidebarShell>
  );
}

export function MobileSidebarTrigger() {
  const t = useTranslations("sidebar");
  const [open, setOpen] = useState(false);

  const closeSheet = useCallback(() => setOpen(false), []);

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <button
          type="button"
          aria-label={t("openMenu")}
          className="flex items-center justify-center rounded-md p-2 text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground md:hidden"
        >
          <Menu className="h-5 w-5" />
        </button>
      </SheetTrigger>
      <SheetContent aria-label={t("openMenu")}>
        <TooltipProvider>
          <SidebarContent collapsed={false} onNavigate={closeSheet} />
        </TooltipProvider>
      </SheetContent>
    </Sheet>
  );
}
