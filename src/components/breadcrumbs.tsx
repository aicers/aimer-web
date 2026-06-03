"use client";

import { ChevronRight, Home } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { useMemo } from "react";

import { useBreadcrumbLabels } from "@/components/breadcrumb-label-store";
import { useCustomerContext } from "@/hooks/use-customer-context";
import { entityCrumbLabel } from "@/lib/navigation/breadcrumb-labels";

type NavKey =
  | "overview"
  | "suspiciousEvents"
  | "threatStories"
  | "threatStory"
  | "event"
  | "reports"
  | "settings"
  | "members"
  | "customerSettings"
  | "customers";

// Report period route enum values (`[period]` segment). Localized via the
// `reportPeriod` namespace; any other value falls back to itself.
const PERIOD_KEYS = new Set(["LIVE", "DAILY", "WEEKLY", "MONTHLY"]);

// Context handed to each node's label resolver.
interface ResolveContext {
  t: (key: NavKey) => string;
  customerName: (id: string) => string | undefined;
  // Localized report-period label (e.g. "DAILY" → "Daily"/"일간").
  period: (value: string) => string;
}

// Accumulated dynamic-segment values along the matched path, keyed by the
// node's `paramName` (e.g. `customerId`, `period`, `eventKey`).
type Params = Record<string, string>;

type LabelResolver = (
  value: string,
  params: Params,
  ctx: ResolveContext,
) => string;

// How a matched segment renders:
//   - "link": a navigable `<Link>` (the segment has a real page);
//   - "text": a plain-text span (a structural prefix with no index page
//     that would 404 if linked — e.g. `customers`, `[period]`);
//   - "collapsed": matched and descended through, but emits NO crumb.
type CrumbKind = "link" | "text" | "collapsed";

interface RouteNode {
  kind: CrumbKind;
  // Omitted for "collapsed" nodes; defaults to the raw segment otherwise.
  label?: LabelResolver;
  // Records this segment's value under `params` when it is a dynamic match.
  paramName?: string;
  // Exact-match children, tried before `param`.
  children?: Record<string, RouteNode>;
  // Wildcard child matching any segment (dynamic route segment).
  param?: RouteNode;
}

const navLabel =
  (key: NavKey): LabelResolver =>
  (_value, _params, ctx) =>
    ctx.t(key);

// The route map mirrors `src/app/[locale]/(dashboard)/`. The same segment
// string means different things at different depths (`events` is the
// top-level page, the customer-scoped Suspicious Events list, AND the
// aice-scoped raw-events prefix), so labels are resolved by position, not
// by a flat segment→label lookup.
//
// Non-navigable structural segments (#393):
//   - `customers` — plain text (no `/customers` index page);
//   - the customer-scoped `analysis` — collapsed (no page, no user-facing
//     meaning distinct from its children);
//   - `[period]` — plain text (only `[period]/[bucketDate]` exists);
//   - `aice` / `[aiceId]` / the aice-scoped `events` / `[eventKey]` —
//     collapsed. Explicit decision (#393 Scope "make that call"): the aice
//     prefix and the raw event ids carry no crumbs of their own; the event
//     leaf instead renders one "Event · <short-key>" crumb. So no
//     `nav.aice` key is added.
const ROOT: RouteNode = {
  kind: "collapsed",
  children: {
    overview: { kind: "link", label: navLabel("overview") },
    "suspicious-events": { kind: "link", label: navLabel("suspiciousEvents") },
    "threat-stories": { kind: "link", label: navLabel("threatStories") },
    reports: { kind: "link", label: navLabel("reports") },
    settings: {
      kind: "link",
      label: navLabel("settings"),
      children: {
        members: { kind: "link", label: navLabel("members") },
        customer: { kind: "link", label: navLabel("customerSettings") },
      },
    },
    customers: {
      kind: "text",
      label: navLabel("customers"),
      param: {
        // [customerId] — customer hub. Name resolved from the ambient
        // `useCustomerContext` set (no refetch); falls back to the id.
        kind: "link",
        paramName: "customerId",
        label: (value, _params, ctx) => ctx.customerName(value) ?? value,
        children: {
          analysis: {
            kind: "collapsed",
            children: {
              events: { kind: "link", label: navLabel("suspiciousEvents") },
              reports: {
                kind: "link",
                label: navLabel("reports"),
                param: {
                  // [period] — plain text (localized "Daily"/"Weekly"/…);
                  // no page here.
                  kind: "text",
                  paramName: "period",
                  label: (value, _params, ctx) => ctx.period(value),
                  param: {
                    // [bucketDate] — the report leaf page. A LIVE report has
                    // no fixed bucket, so the localized period word stands in
                    // for the date; otherwise the date itself is the label.
                    kind: "link",
                    paramName: "bucketDate",
                    label: (value, params, ctx) =>
                      params.period === "LIVE" ? ctx.period("LIVE") : value,
                  },
                },
              },
              story: {
                kind: "link",
                label: navLabel("threatStories"),
                param: {
                  // [storyId] — threat story leaf. Page may register a
                  // richer label; this is the terminology + short-id
                  // fallback.
                  kind: "link",
                  paramName: "storyId",
                  label: (value, _params, ctx) =>
                    entityCrumbLabel(ctx.t("threatStory"), value),
                },
              },
            },
          },
          aice: {
            kind: "collapsed",
            param: {
              kind: "collapsed",
              paramName: "aiceId",
              children: {
                events: {
                  kind: "collapsed",
                  param: {
                    kind: "collapsed",
                    paramName: "eventKey",
                    children: {
                      analysis: {
                        // Event-analysis leaf. The collapsed aice prefix
                        // means this is the only aice-scope crumb; label
                        // from the [eventKey] captured above.
                        kind: "link",
                        label: (_value, params, ctx) =>
                          entityCrumbLabel(ctx.t("event"), params.eventKey),
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
};

interface Crumb {
  label: string;
  href: string;
  navigable: boolean;
}

function resolveCrumbs(
  segments: string[],
  base: string,
  ctx: ResolveContext,
  labels: ReadonlyMap<string, string>,
): Crumb[] {
  const crumbs: Crumb[] = [];
  const params: Params = {};
  let node: RouteNode = ROOT;
  let href = base;

  for (const segment of segments) {
    const next = node.children?.[segment] ?? node.param;
    // An unknown segment means we have walked off the known route map;
    // stop rather than emit raw-id crumbs for paths we do not model.
    if (!next) break;

    href += `/${segment}`;
    if (next.paramName) params[next.paramName] = segment;

    if (next.kind !== "collapsed") {
      // A page-registered label (keyed by full path) wins over the
      // computed one; otherwise resolve the node's label, defaulting to
      // the raw segment.
      const computed = next.label ? next.label(segment, params, ctx) : segment;
      crumbs.push({
        label: labels.get(href) ?? computed,
        href,
        navigable: next.kind === "link",
      });
    }

    node = next;
  }

  return crumbs;
}

export function Breadcrumbs() {
  const pathname = usePathname();
  const locale = useLocale();
  const t = useTranslations("nav");
  const tp = useTranslations("reportPeriod");
  const { customers } = useCustomerContext();
  const labels = useBreadcrumbLabels();

  const crumbs = useMemo(() => {
    const base = `/${locale}`;
    const rest = pathname.startsWith(base)
      ? pathname.slice(base.length)
      : pathname;
    const segments = rest.split("/").filter(Boolean);

    const customerName = (id: string) =>
      customers.find((c) => c.id === id)?.name;
    const period = (value: string) =>
      PERIOD_KEYS.has(value)
        ? tp(value as "LIVE" | "DAILY" | "WEEKLY" | "MONTHLY")
        : value;

    return resolveCrumbs(segments, base, { t, customerName, period }, labels);
  }, [pathname, locale, t, tp, customers, labels]);

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
          {crumb.navigable ? (
            <Link
              href={crumb.href}
              className="text-muted-foreground transition-colors hover:text-foreground"
            >
              {crumb.label}
            </Link>
          ) : (
            <span className="text-muted-foreground">{crumb.label}</span>
          )}
        </span>
      ))}
    </nav>
  );
}
