"use client";

import { useTranslations } from "next-intl";

import { LocaleSwitcher } from "@/components/locale-switcher";
import { Sidebar } from "@/components/sidebar";
import { ThemeToggle } from "@/components/theme-toggle";
import {
  CustomerContextProvider,
  useCustomerContext,
} from "@/hooks/use-customer-context";

function DashboardShell({ children }: { children: React.ReactNode }) {
  const { loading } = useCustomerContext();
  const t = useTranslations("common");

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <p className="text-sm text-muted-foreground">{t("loading")}</p>
      </div>
    );
  }

  return (
    <div className="flex h-screen">
      <Sidebar />
      <div className="flex flex-1 flex-col overflow-hidden">
        <header className="flex h-14 items-center justify-end gap-2 border-b border-border px-4">
          <ThemeToggle />
          <LocaleSwitcher />
        </header>
        <main id="main-content" className="flex-1 overflow-y-auto">
          {children}
        </main>
      </div>
    </div>
  );
}

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <CustomerContextProvider>
      <DashboardShell>{children}</DashboardShell>
    </CustomerContextProvider>
  );
}
