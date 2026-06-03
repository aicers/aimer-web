"use client";

import { useLocale, useTranslations } from "next-intl";
import { Suspense, useCallback } from "react";

import { BreadcrumbLabelProvider } from "@/components/breadcrumb-label-store";
import { Breadcrumbs } from "@/components/breadcrumbs";
import { AppHeader } from "@/components/header";
import {
  MobileSidebarTrigger,
  Sidebar,
  useSidebarCollapsed,
} from "@/components/sidebar";
import {
  CustomerContextProvider,
  useCustomerContext,
} from "@/hooks/use-customer-context";
import { apiFetch } from "@/lib/api/client";

function DashboardShell({ children }: { children: React.ReactNode }) {
  const { loading, me } = useCustomerContext();
  const t = useTranslations("common");
  const locale = useLocale();
  const { collapsed, toggle } = useSidebarCollapsed();

  const signOut = useCallback(async () => {
    try {
      const { logoutUrl } = await apiFetch<{ logoutUrl: string }>(
        "/api/auth/sign-out",
        { method: "POST" },
      );
      window.location.href = logoutUrl;
    } catch {
      window.location.href = "/";
    }
  }, []);

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <p className="text-sm text-muted-foreground">{t("loading")}</p>
      </div>
    );
  }

  return (
    <div className="flex h-screen flex-col">
      <AppHeader
        collapsed={collapsed}
        onToggleSidebar={toggle}
        homeHref={`/${locale}`}
        user={me}
        onSignOut={signOut}
        mobileMenuTrigger={<MobileSidebarTrigger />}
      />
      <div className="flex flex-1 overflow-hidden">
        <Sidebar collapsed={collapsed} />
        {/* Provider wraps both `<Breadcrumbs />` and the page subtree so a
            leaf page's `<BreadcrumbLabelRegistrar />` can feed the crumb its
            resolved label across the client/server boundary (#393). */}
        <BreadcrumbLabelProvider>
          <div className="flex flex-1 flex-col overflow-hidden">
            <div className="flex shrink-0 items-center px-6 py-2">
              <Breadcrumbs />
            </div>
            <main id="main-content" className="flex-1 overflow-y-auto">
              {children}
            </main>
          </div>
        </BreadcrumbLabelProvider>
      </div>
    </div>
  );
}

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // The provider derives the active scope from the URL via
  // `useSearchParams`, which requires a Suspense boundary to keep static
  // rendering from bailing out at build time.
  return (
    <Suspense>
      <CustomerContextProvider>
        <DashboardShell>{children}</DashboardShell>
      </CustomerContextProvider>
    </Suspense>
  );
}
