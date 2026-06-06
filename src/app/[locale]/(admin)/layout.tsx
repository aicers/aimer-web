"use client";

import {
  Building2,
  FileText,
  Globe,
  Menu,
  Settings,
  ShieldAlert,
  ShieldCheck,
  UserSearch,
  Users,
} from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useCallback, useEffect, useState } from "react";

import { AppHeader } from "@/components/header";
import {
  type NavItem,
  NavList,
  SidebarShell,
  useSidebarCollapsed,
} from "@/components/sidebar";
import { Sheet, SheetContent, SheetTrigger } from "@/components/ui/sheet";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AccountTimezoneProvider } from "@/hooks/use-account-timezone";
import { adminFetch, getAdminCsrfToken } from "@/lib/api/admin-client";

function useAdminNavItems(): NavItem[] {
  const t = useTranslations("admin");
  const locale = useLocale();

  return [
    {
      href: `/${locale}/admin/accounts`,
      label: t("accounts"),
      icon: Users,
    },
    {
      href: `/${locale}/admin/admins`,
      label: t("admins"),
      icon: ShieldCheck,
    },
    {
      href: `/${locale}/admin/analysts`,
      label: t("analysts"),
      icon: UserSearch,
    },
    {
      href: `/${locale}/admin/customers`,
      label: t("customers"),
      icon: Building2,
    },
    {
      href: `/${locale}/admin/environments`,
      label: t("environments"),
      icon: Globe,
    },
    {
      href: `/${locale}/admin/audit-logs`,
      label: t("auditLog"),
      icon: FileText,
    },
    {
      href: `/${locale}/admin/suspicious-activity`,
      label: t("suspiciousActivity"),
      icon: ShieldAlert,
    },
    {
      href: `/${locale}/admin`,
      label: t("settings"),
      icon: Settings,
      exact: true,
    },
  ];
}

function AdminMobileTrigger({ navItems }: { navItems: NavItem[] }) {
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
          <NavList
            items={navItems}
            collapsed={false}
            ariaLabel="Admin"
            onNavigate={closeSheet}
          />
        </TooltipProvider>
      </SheetContent>
    </Sheet>
  );
}

export default function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const locale = useLocale();
  const tNav = useTranslations("nav");
  const { collapsed, toggle } = useSidebarCollapsed();
  const navItems = useAdminNavItems();
  const [adminUser, setAdminUser] = useState<{
    displayName: string;
    email?: string | null;
    timezone?: string | null;
  } | null>(null);

  useEffect(() => {
    let cancelled = false;
    adminFetch<{
      displayName: string;
      email: string | null;
      timezone: string | null;
    }>("/api/admin-auth/me")
      .then((data) => {
        if (!cancelled) setAdminUser(data);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const handleSignOut = useCallback(async () => {
    try {
      const res = await fetch("/api/admin-auth/sign-out", {
        method: "POST",
        headers: { "X-CSRF-Token-Admin": getAdminCsrfToken() },
      });
      if (res.ok) {
        const body = (await res.json()) as { logoutUrl: string | null };
        window.location.href = body.logoutUrl ?? "/api/admin-auth/sign-in";
      } else {
        window.location.href = "/api/admin-auth/sign-in";
      }
    } catch {
      window.location.href = "/api/admin-auth/sign-in";
    }
  }, []);

  return (
    <div className="flex h-screen flex-col">
      <AppHeader
        collapsed={collapsed}
        onToggleSidebar={toggle}
        homeHref={`/${locale}/admin`}
        contextLabel={
          <span className="rounded bg-[var(--sidebar-active)] px-1.5 py-0.5 text-xs font-medium text-white">
            {tNav("admin")}
          </span>
        }
        user={adminUser}
        onSignOut={handleSignOut}
        mobileMenuTrigger={<AdminMobileTrigger navItems={navItems} />}
      />
      <div className="flex flex-1 overflow-hidden">
        <SidebarShell collapsed={collapsed}>
          <NavList items={navItems} collapsed={collapsed} ariaLabel="Admin" />
        </SidebarShell>
        <main id="main-content" className="flex-1 overflow-y-auto">
          <AccountTimezoneProvider timezone={adminUser?.timezone ?? null}>
            {children}
          </AccountTimezoneProvider>
        </main>
      </div>
    </div>
  );
}
