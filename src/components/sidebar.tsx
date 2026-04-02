"use client";

import {
  BarChart3,
  ChevronLeft,
  ChevronRight,
  FileText,
  Home,
  LayoutDashboard,
  Lock,
  LogOut,
  Menu,
  Search,
  Settings,
  Shield,
  Users,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
} from "react";

import { LocaleSwitcher } from "@/components/locale-switcher";
import { ThemeToggle } from "@/components/theme-toggle";
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
import { apiFetch } from "@/lib/api/client";
import { cn } from "@/lib/utils";

import {
  HEADER_HEIGHT,
  SIDEBAR_WIDTH_COLLAPSED,
  SIDEBAR_WIDTH_EXPANDED,
} from "./layout-constants";

const SIDEBAR_COLLAPSED_KEY = "sidebar-collapsed";

/**
 * Callback context used by `MobileSidebarTrigger` to close the sheet
 * when a navigation link is clicked.
 */
const OnNavigateContext = createContext<(() => void) | null>(null);

interface NavItem {
  href: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  visible: boolean;
}

function useNavItems(): NavItem[] {
  const t = useTranslations("nav");
  const locale = useLocale();
  const permissions = usePermissions();

  return [
    { href: `/${locale}`, label: t("home"), icon: Home, visible: true },
    {
      href: `/${locale}/events`,
      label: t("events"),
      icon: Shield,
      visible: true,
    },
    {
      href: `/${locale}/analysis`,
      label: t("analysis"),
      icon: Search,
      visible: true,
    },
    {
      href: `/${locale}/reports`,
      label: t("reports"),
      icon: FileText,
      visible: true,
    },
    {
      href: `/${locale}/dashboard`,
      label: t("dashboard"),
      icon: LayoutDashboard,
      visible: true,
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

function NavList({
  items,
  collapsed,
}: {
  items: NavItem[];
  collapsed: boolean;
}) {
  const pathname = usePathname();
  const locale = useLocale();
  const onNavigate = useContext(OnNavigateContext);

  const visible = items.filter((item) => item.visible);

  return (
    <nav aria-label="Main" className="flex-1 overflow-y-auto p-2">
      <ul className="space-y-1">
        {visible.map((item) => {
          const isActive =
            item.href === `/${locale}`
              ? pathname === item.href
              : pathname.startsWith(item.href);

          const link = (
            <Link
              href={item.href}
              onClick={onNavigate ?? undefined}
              aria-current={isActive ? "page" : undefined}
              className={cn(
                "flex items-center rounded-md text-sm font-medium transition-colors",
                collapsed ? "justify-center p-2" : "gap-3 px-3 py-2",
                isActive
                  ? "bg-[var(--sidebar-active)] text-white"
                  : "text-[var(--sidebar-muted)] hover:bg-[var(--sidebar-account-bg)] hover:text-[var(--sidebar-fg)]",
              )}
            >
              <item.icon className="h-4 w-4 shrink-0" />
              {collapsed ? (
                <span className="sr-only">{item.label}</span>
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

function UserSection({ collapsed }: { collapsed: boolean }) {
  const t = useTranslations("auth");
  const { me } = useCustomerContext();

  const signOut = useCallback(async () => {
    try {
      const { logoutUrl } = await apiFetch<{ logoutUrl: string }>(
        "/api/auth/sign-out",
        { method: "POST" },
      );
      window.location.href = logoutUrl;
    } catch {
      // Fallback: reload to trigger auth redirect
      window.location.href = "/";
    }
  }, []);

  if (collapsed) {
    return (
      <div className="space-y-1 border-t border-[var(--sidebar-border)] p-2">
        <ThemeToggle className="w-full" />
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={signOut}
              aria-label={t("signOut")}
              className="flex w-full items-center justify-center rounded-md p-2 text-[var(--sidebar-muted)] transition-colors hover:bg-[var(--sidebar-account-bg)] hover:text-[var(--sidebar-fg)]"
            >
              <LogOut className="h-4 w-4" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="right">{t("signOut")}</TooltipContent>
        </Tooltip>
      </div>
    );
  }

  return (
    <div className="border-t border-[var(--sidebar-border)] p-3">
      {me && (
        <div className="mb-3 rounded-md bg-[var(--sidebar-account-bg)] px-3 py-2">
          <p className="truncate text-sm font-medium text-[var(--sidebar-fg)]">
            {me.displayName}
          </p>
          {me.email && (
            <p className="truncate text-xs text-[var(--sidebar-muted)]">
              {me.email}
            </p>
          )}
        </div>
      )}
      <div className="flex items-center gap-1">
        <ThemeToggle />
        <LocaleSwitcher />
        <button
          type="button"
          onClick={signOut}
          className="ml-auto flex items-center gap-2 rounded-md px-3 py-2 text-sm text-[var(--sidebar-muted)] transition-colors hover:bg-[var(--sidebar-account-bg)] hover:text-[var(--sidebar-fg)]"
        >
          <LogOut className="h-4 w-4" />
          {t("signOut")}
        </button>
      </div>
    </div>
  );
}

function SidebarLogo({ collapsed }: { collapsed: boolean }) {
  const locale = useLocale();
  const onNavigate = useContext(OnNavigateContext);

  return (
    <Link
      href={`/${locale}`}
      onClick={onNavigate ?? undefined}
      className={cn(
        `flex ${HEADER_HEIGHT} items-center border-b border-[var(--sidebar-border)] transition-colors hover:bg-[var(--sidebar-account-bg)]`,
        collapsed ? "justify-center px-2" : "px-4",
      )}
    >
      <BarChart3
        className={cn(
          "shrink-0 text-[var(--sidebar-active)]",
          collapsed ? "h-6 w-6" : "h-7 w-7",
        )}
      />
      {collapsed ? (
        <span className="sr-only">AIMER</span>
      ) : (
        <span className="ml-2 text-lg font-bold text-[var(--sidebar-fg)]">
          AIMER
        </span>
      )}
    </Link>
  );
}

function SidebarContent({ collapsed }: { collapsed: boolean }) {
  const navItems = useNavItems();

  return (
    <>
      <SidebarLogo collapsed={collapsed} />
      <CustomerSelector collapsed={collapsed} />
      <NavList items={navItems} collapsed={collapsed} />
      <UserSection collapsed={collapsed} />
    </>
  );
}

export function Sidebar() {
  const t = useTranslations("sidebar");
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

  return (
    <TooltipProvider>
      <aside
        className={cn(
          "hidden h-full flex-col border-r border-[var(--sidebar-border)] bg-[var(--sidebar-bg)] transition-[width] duration-200 md:flex",
          collapsed ? SIDEBAR_WIDTH_COLLAPSED : SIDEBAR_WIDTH_EXPANDED,
        )}
      >
        <SidebarContent collapsed={collapsed} />
        <div className="border-t border-[var(--sidebar-border)] p-2">
          <button
            type="button"
            onClick={toggle}
            aria-label={collapsed ? t("expandSidebar") : t("collapseSidebar")}
            className="flex w-full items-center justify-center rounded-md p-2 text-[var(--sidebar-muted)] transition-colors hover:bg-[var(--sidebar-account-bg)] hover:text-[var(--sidebar-fg)]"
          >
            {collapsed ? (
              <ChevronRight className="h-4 w-4" />
            ) : (
              <ChevronLeft className="h-4 w-4" />
            )}
          </button>
        </div>
      </aside>
    </TooltipProvider>
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
          <OnNavigateContext.Provider value={closeSheet}>
            <SidebarContent collapsed={false} />
          </OnNavigateContext.Provider>
        </TooltipProvider>
      </SheetContent>
    </Sheet>
  );
}
