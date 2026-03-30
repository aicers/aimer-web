"use client";

import { useTranslations } from "next-intl";

import { Breadcrumbs } from "@/components/breadcrumbs";
import { HEADER_HEIGHT } from "@/components/layout-constants";
import { MobileSidebarTrigger, Sidebar } from "@/components/sidebar";
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
        <header
          className={`flex ${HEADER_HEIGHT} shrink-0 items-center gap-2 border-b border-border px-4`}
        >
          <MobileSidebarTrigger />
          <Breadcrumbs />
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
