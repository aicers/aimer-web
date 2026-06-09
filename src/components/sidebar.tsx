"use client";

import {
  Building2,
  FileText,
  LayoutDashboard,
  Lock,
  Menu,
  Search,
  Settings,
  Shield,
  UserCog,
  Users,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { useCallback, useEffect, useState } from "react";

import { Sheet, SheetContent, SheetTrigger } from "@/components/ui/sheet";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useCustomerContext } from "@/hooks/use-customer-context";
import { usePermissions } from "@/hooks/use-permissions";
import { mergeQuery } from "@/lib/navigation/query";
import { subjectPages } from "@/lib/navigation/routes";
import { SCOPE_PARAM } from "@/lib/navigation/scope";
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
  /**
   * Query string (without the leading `?`) carried on the link, kept
   * separate from {@link href} so active-item matching stays path-only.
   * Used to preserve the active customer scope across sidebar navigation.
   */
  query?: string;
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
  const { singleCustomerId, scope } = useCustomerContext();

  // Members and Customer Settings render against a single customer. They are
  // reachable only when the active scope resolves to exactly one customer;
  // under a multi-/all-scope their links are hidden (#390). `usePermissions`
  // already returns false here when there is no single customer, but gate
  // explicitly so the intent is clear.
  const singleScope = singleCustomerId !== null;

  // Preserve the active scope as the user navigates between sidebar
  // destinations (#390). The all-scope is represented as an absent param
  // (clean URLs), so only a narrowed scope carries a query. This is what
  // keeps the single-customer settings links valid: clicking them under a
  // `?scope=c1` subset must arrive at the page WITH that scope, otherwise
  // the page re-normalizes to all customers and renders the scope-required
  // state. Kept off `href` so active-item matching stays path-only.
  const scopeQuery = scope.isAll
    ? undefined
    : mergeQuery(null, { [SCOPE_PARAM]: scope.canonical });

  return [
    {
      href: `/${locale}/overview`,
      label: t("overview"),
      icon: LayoutDashboard,
      query: scopeQuery,
    },
    {
      href: `/${locale}/reports`,
      label: t("reports"),
      icon: FileText,
      query: scopeQuery,
    },
    {
      href: `/${locale}/threat-stories`,
      label: t("threatStories"),
      icon: Shield,
      query: scopeQuery,
    },
    {
      href: `/${locale}/suspicious-events`,
      label: t("suspiciousEvents"),
      icon: Search,
      query: scopeQuery,
    },
    {
      href: `/${locale}/settings/account`,
      label: t("accountSettings"),
      icon: UserCog,
    },
    {
      href: `/${locale}/settings/members`,
      label: t("members"),
      icon: Users,
      visible: singleScope && permissions.canViewMembers,
      query: scopeQuery,
    },
    {
      href: `/${locale}/settings/customer`,
      label: t("customerSettings"),
      icon: Settings,
      visible: singleScope && permissions.canViewCustomerSettings,
      query: scopeQuery,
    },
  ];
}

function ScopeSelector({ collapsed }: { collapsed: boolean }) {
  const tSidebar = useTranslations("sidebar");
  const { customers, scope, setScope, isBridgeSession } = useCustomerContext();

  if (collapsed) return null;

  // Bridge sessions are pinned to a fixed bridge scope and cannot read
  // cross-customer surfaces — short-circuit the control (not just disable
  // it) and show the locked notice.
  if (isBridgeSession) {
    return (
      <div className="border-b border-[var(--sidebar-border)] p-3">
        <div className="mb-1 flex items-center text-xs font-medium text-[var(--sidebar-muted)]">
          <Lock className="mr-1 h-3 w-3" />
          {tSidebar("scopeLabel")}
        </div>
        <p className="flex items-center text-xs text-[var(--sidebar-muted)]">
          <Lock className="mr-1 h-3 w-3" />
          {tSidebar("bridgeLocked")}
        </p>
      </div>
    );
  }

  // When the scope is `all`, every accessible customer is checked. Toggling
  // one off narrows to the remaining subset; re-checking the last one (or
  // checking every box) collapses back to `all` via `normalizeScope`.
  const checked = new Set(
    scope.isAll ? customers.map((c) => c.id) : scope.customerIds,
  );

  function toggle(id: string) {
    const next = new Set(checked);
    if (next.has(id)) {
      next.delete(id);
    } else {
      next.add(id);
    }
    setScope([...next]);
  }

  return (
    <div className="border-b border-[var(--sidebar-border)] p-3">
      <div
        id="scope-label"
        className="mb-2 text-xs font-medium text-[var(--sidebar-muted)]"
      >
        {tSidebar("scopeLabel")}
      </div>
      <ul aria-labelledby="scope-label" className="space-y-1">
        {customers.map((c) => (
          <li key={c.id}>
            <label className="flex items-center gap-2 text-sm text-[var(--sidebar-fg)]">
              <input
                type="checkbox"
                checked={checked.has(c.id)}
                onChange={() => toggle(c.id)}
                className="h-4 w-4 shrink-0 rounded border-border"
              />
              <span className="truncate">{c.name}</span>
            </label>
          </li>
        ))}
      </ul>
      <p className="mt-2 text-xs text-[var(--sidebar-muted)]">
        {scope.isAll
          ? tSidebar("scopeAll")
          : tSidebar("scopeSelected", {
              count: scope.customerIds.length,
              total: customers.length,
            })}
      </p>
    </div>
  );
}

/**
 * Persistent links to each accessible customer's analysis hub
 * (`subjectPages.hub` → `/subjects/[subjectId]`). This is the summary-subjects
 * navigation introduced by RFC 0004 (#504): it closes the orphaned-hub gap so
 * a customer's hub is reachable directly from the sidebar instead of only via
 * a detail-page breadcrumb.
 *
 * Deliberately separate from {@link useNavItems}: those cross-customer browse
 * items append the active scope query (`?scope=`), whereas subject links must
 * NOT — clicking a subject opens its own hub and never mutates the ephemeral
 * scope filter driven by {@link ScopeSelector}. The two customer lists stay
 * visibly distinct controls with different jobs.
 *
 * Bridge sessions need no special branching: `useCustomerContext().customers`
 * is already filtered to the bridge scope server-side
 * (`/api/auth/customers`), so the rendered hub links expose nothing the
 * session cannot read.
 */
function SummarySubjects({
  collapsed,
  onNavigate,
}: {
  collapsed: boolean;
  onNavigate?: (() => void) | null;
}) {
  const tSidebar = useTranslations("sidebar");
  const locale = useLocale();
  const pathname = usePathname();
  const { customers } = useCustomerContext();

  if (customers.length === 0) return null;

  const label = tSidebar("summarySubjectsLabel");

  const items = customers.map((c) => {
    const href = subjectPages.hub(locale, c.id);
    // Match the hub path or anything nested under it (reports / story /
    // events), but not a sibling whose id is a prefix of this one.
    const isActive = pathname === href || pathname.startsWith(`${href}/`);
    return { id: c.id, name: c.name, href, isActive };
  });

  const linkClass = (isActive: boolean) =>
    cn(
      "flex items-center rounded-md font-medium transition-colors",
      collapsed
        ? "flex-col justify-center gap-0.5 px-1 py-2 text-[10px]"
        : "gap-2 px-2 py-1.5 text-sm",
      isActive
        ? "bg-[var(--sidebar-active)] text-white"
        : "text-[var(--sidebar-fg)] hover:bg-[var(--sidebar-account-bg)] hover:text-[var(--sidebar-fg)]",
    );

  return (
    <nav
      aria-label={label}
      className="max-h-56 shrink-0 overflow-y-auto border-t border-[var(--sidebar-border)] p-2"
    >
      {!collapsed && (
        <div
          id="summary-subjects-label"
          className="mb-2 px-1 text-xs font-medium text-[var(--sidebar-muted)]"
        >
          {label}
        </div>
      )}
      <ul className="space-y-1">
        {items.map((item) => {
          const link = (
            <Link
              href={item.href}
              onClick={onNavigate ?? undefined}
              aria-current={item.isActive ? "page" : undefined}
              className={linkClass(item.isActive)}
            >
              <Building2 className="h-4 w-4 shrink-0" />
              {collapsed ? (
                <span className="w-full truncate text-center">{item.name}</span>
              ) : (
                <span className="truncate">{item.name}</span>
              )}
            </Link>
          );

          if (collapsed) {
            return (
              <li key={item.id}>
                <Tooltip>
                  <TooltipTrigger asChild>{link}</TooltipTrigger>
                  <TooltipContent side="right">{item.name}</TooltipContent>
                </Tooltip>
              </li>
            );
          }

          return <li key={item.id}>{link}</li>;
        })}
      </ul>
    </nav>
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

          // Active matching is path-only (above); the scope query is added
          // here so navigating between sidebar destinations carries it.
          const linkHref = item.query
            ? `${item.href}?${item.query}`
            : item.href;

          const link = (
            <Link
              href={linkHref}
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
      <ScopeSelector collapsed={collapsed} />
      <NavList items={navItems} collapsed={collapsed} onNavigate={onNavigate} />
      <SummarySubjects collapsed={collapsed} onNavigate={onNavigate} />
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
