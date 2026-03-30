"use client";

import { ChevronRight, Home } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { useMemo } from "react";

type NavKey =
  | "events"
  | "analysis"
  | "reports"
  | "dashboard"
  | "settings"
  | "members"
  | "customerSettings";

const SEGMENT_KEYS: Record<string, NavKey> = {
  events: "events",
  analysis: "analysis",
  reports: "reports",
  dashboard: "dashboard",
  settings: "settings",
  members: "members",
  customer: "customerSettings",
};

export function Breadcrumbs() {
  const pathname = usePathname();
  const locale = useLocale();
  const t = useTranslations("nav");

  const crumbs = useMemo(() => {
    const base = `/${locale}`;
    const rest = pathname.startsWith(base)
      ? pathname.slice(base.length)
      : pathname;
    const segments = rest.split("/").filter(Boolean);

    const items: { label: string; href: string }[] = [];
    let accumulated = base;

    for (const segment of segments) {
      accumulated += `/${segment}`;
      const key = SEGMENT_KEYS[segment];
      if (key) {
        items.push({ label: t(key), href: accumulated });
      }
    }

    return items;
  }, [pathname, locale, t]);

  return (
    <nav aria-label="Breadcrumb" className="flex items-center gap-1.5 text-sm">
      <Link
        href={`/${locale}`}
        className="flex items-center text-muted-foreground transition-colors hover:text-foreground"
      >
        <Home className="h-4 w-4" />
      </Link>
      {crumbs.map((crumb) => (
        <span key={crumb.href} className="flex items-center gap-1.5">
          <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
          <Link
            href={crumb.href}
            className="text-muted-foreground transition-colors hover:text-foreground"
          >
            {crumb.label}
          </Link>
        </span>
      ))}
    </nav>
  );
}
