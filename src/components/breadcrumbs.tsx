"use client";

import { ChevronRight, Home } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { useMemo } from "react";

type NavKey =
  | "overview"
  | "suspiciousEvents"
  | "threatStories"
  | "reports"
  | "settings"
  | "members"
  | "customerSettings";

// Maps a path segment to its `nav.*` label key. Top-level cross-customer
// routes use the new identifiers (`suspicious-events`, `threat-stories`);
// the deep `events`/`story` segments keep their identifiers but reuse the
// plural labels so every user-facing crumb reads "Suspicious Events" /
// "Threat Stories" (parent route policy, #394). The deep `analysis` segment
// is intentionally absent — `/customers/:id/analysis` has no page, only
// `events`/`reports`/`story` children, so a crumb link there would 404.
const SEGMENT_KEYS: Record<string, NavKey> = {
  overview: "overview",
  "suspicious-events": "suspiciousEvents",
  "threat-stories": "threatStories",
  events: "suspiciousEvents",
  story: "threatStories",
  reports: "reports",
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
        aria-label={t("home")}
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
