"use client";

import { BarChart3, ChevronDown, LogOut, Menu } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";

import { HEADER_HEIGHT } from "@/components/layout-constants";
import { LocaleSwitcher } from "@/components/locale-switcher";
import { ThemeToggle } from "@/components/theme-toggle";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

interface AppHeaderProps {
  collapsed: boolean;
  onToggleSidebar: () => void;
  homeHref: string;
  contextLabel?: ReactNode;
  user?: { displayName: string; email?: string | null } | null;
  onSignOut: () => void;
  mobileMenuTrigger: ReactNode;
}

export function AppHeader({
  collapsed,
  onToggleSidebar,
  homeHref,
  contextLabel,
  user,
  onSignOut,
  mobileMenuTrigger,
}: AppHeaderProps) {
  const tSidebar = useTranslations("sidebar");
  const tAuth = useTranslations("auth");

  return (
    <header
      className={`flex ${HEADER_HEIGHT} shrink-0 items-center border-b border-border bg-[var(--sidebar-bg)] px-4`}
    >
      <div className="flex items-center gap-3">
        {mobileMenuTrigger}
        <button
          type="button"
          onClick={onToggleSidebar}
          aria-label={
            collapsed ? tSidebar("expandSidebar") : tSidebar("collapseSidebar")
          }
          className="hidden items-center justify-center rounded-md p-2 text-[var(--sidebar-muted)] transition-colors hover:bg-[var(--sidebar-account-bg)] hover:text-[var(--sidebar-fg)] md:flex"
        >
          <Menu className="h-5 w-5" />
        </button>
        <Link href={homeHref} className="flex items-center gap-2">
          <BarChart3 className="h-6 w-6 shrink-0 text-[var(--sidebar-active)]" />
          <span className="text-lg font-bold text-[var(--sidebar-fg)]">
            AIMER
          </span>
        </Link>
        {contextLabel}
      </div>

      <div className="ml-auto flex items-center gap-2">
        <ThemeToggle />
        <LocaleSwitcher />
        {user && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className="hidden items-center gap-2 border-l border-[var(--sidebar-border)] pl-3 md:flex rounded-md py-1 pr-1 transition-colors hover:bg-[var(--sidebar-account-bg)]"
              >
                <div className="flex h-8 w-8 items-center justify-center rounded-full bg-[var(--sidebar-active)] text-xs font-medium text-white">
                  {user.displayName.charAt(0).toUpperCase()}
                </div>
                <div className="text-left">
                  <p className="text-sm font-medium leading-tight text-[var(--sidebar-fg)]">
                    {user.displayName}
                  </p>
                  {user.email && (
                    <p className="text-xs leading-tight text-[var(--sidebar-muted)]">
                      {user.email}
                    </p>
                  )}
                </div>
                <ChevronDown className="h-4 w-4 text-[var(--sidebar-muted)]" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-48">
              <div className="px-2 py-1.5">
                <p className="text-sm font-medium">{user.displayName}</p>
                {user.email && (
                  <p className="text-xs text-muted-foreground">{user.email}</p>
                )}
              </div>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={onSignOut}>
                <LogOut className="h-4 w-4" />
                {tAuth("signOut")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
        {/* Mobile: icon-only sign-out (dropdown not practical on small screens) */}
        {user && (
          <button
            type="button"
            onClick={onSignOut}
            aria-label={tAuth("signOut")}
            className="flex items-center justify-center rounded-md p-2 text-[var(--sidebar-muted)] transition-colors hover:bg-[var(--sidebar-account-bg)] hover:text-[var(--sidebar-fg)] md:hidden"
          >
            <LogOut className="h-4 w-4" />
          </button>
        )}
      </div>
    </header>
  );
}
