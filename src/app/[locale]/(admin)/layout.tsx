"use client";

import {
  BarChart3,
  FileText,
  LogOut,
  Menu,
  Settings,
  ShieldAlert,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { useCallback, useState } from "react";

import { HEADER_HEIGHT } from "@/components/layout-constants";
import { LocaleSwitcher } from "@/components/locale-switcher";
import { ThemeToggle } from "@/components/theme-toggle";
import { Sheet, SheetContent, SheetTrigger } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";

interface AdminNavItem {
  href: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
}

function useAdminNavItems(): AdminNavItem[] {
  const t = useTranslations("admin");
  const locale = useLocale();

  return [
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
    },
  ];
}

function getAdminCsrfToken(): string {
  const match = document.cookie
    .split("; ")
    .find((c) => c.startsWith("csrf_admin="));
  return match ? match.split("=")[1] : "";
}

function AdminSidebarContent({ onNavigate }: { onNavigate?: () => void }) {
  const t = useTranslations("auth");
  const locale = useLocale();
  const pathname = usePathname();
  const navItems = useAdminNavItems();

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
    <>
      {/* Logo */}
      <Link
        href={`/${locale}/admin`}
        onClick={onNavigate}
        className={`flex ${HEADER_HEIGHT} items-center border-b border-[var(--sidebar-border)] px-4 transition-colors hover:bg-[var(--sidebar-account-bg)]`}
      >
        <BarChart3 className="h-7 w-7 shrink-0 text-[var(--sidebar-active)]" />
        <span className="ml-2 text-lg font-bold text-[var(--sidebar-fg)]">
          AIMER
        </span>
        <span className="ml-2 rounded bg-[var(--sidebar-active)] px-1.5 py-0.5 text-xs font-medium text-white">
          Admin
        </span>
      </Link>

      {/* Nav */}
      <nav aria-label="Admin" className="flex-1 overflow-y-auto p-2">
        <ul className="space-y-1">
          {navItems.map((item) => {
            const isActive =
              item.href === `/${locale}/admin`
                ? pathname === item.href
                : pathname.startsWith(item.href);

            return (
              <li key={item.href}>
                <Link
                  href={item.href}
                  onClick={onNavigate}
                  aria-current={isActive ? "page" : undefined}
                  className={cn(
                    "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors",
                    isActive
                      ? "bg-[var(--sidebar-active)] text-white"
                      : "text-[var(--sidebar-muted)] hover:bg-[var(--sidebar-account-bg)] hover:text-[var(--sidebar-fg)]",
                  )}
                >
                  <item.icon className="h-4 w-4 shrink-0" />
                  {item.label}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>

      {/* Footer */}
      <div className="border-t border-[var(--sidebar-border)] p-3">
        <div className="flex items-center gap-1">
          <ThemeToggle />
          <LocaleSwitcher />
          <button
            type="button"
            onClick={handleSignOut}
            className="ml-auto flex items-center gap-2 rounded-md px-3 py-2 text-sm text-[var(--sidebar-muted)] transition-colors hover:bg-[var(--sidebar-account-bg)] hover:text-[var(--sidebar-fg)]"
          >
            <LogOut className="h-4 w-4" />
            {t("signOut")}
          </button>
        </div>
      </div>
    </>
  );
}

function MobileAdminTrigger() {
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
        <AdminSidebarContent onNavigate={closeSheet} />
      </SheetContent>
    </Sheet>
  );
}

export default function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="flex h-screen">
      <aside className="hidden w-64 flex-col border-r border-[var(--sidebar-border)] bg-[var(--sidebar-bg)] md:flex">
        <AdminSidebarContent />
      </aside>

      <div className="flex flex-1 flex-col overflow-hidden">
        <header
          className={`flex ${HEADER_HEIGHT} shrink-0 items-center border-b border-border px-4 md:hidden`}
        >
          <MobileAdminTrigger />
        </header>
        <main id="main-content" className="flex-1 overflow-y-auto">
          {children}
        </main>
      </div>
    </div>
  );
}
