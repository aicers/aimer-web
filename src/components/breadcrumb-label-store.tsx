"use client";

import { usePathname } from "next/navigation";
import { useLocale } from "next-intl";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";

import { useAccountTimezone } from "@/hooks/use-account-timezone";
import {
  formatDateTimeCompact,
  resolveDisplayTimeZone,
} from "@/lib/datetime/format-timestamp";
import { eventKindDisplayName } from "@/lib/events/event-kind-names";

// Client-side breadcrumb-label store.
//
// The dashboard layout is a client component that renders `<Breadcrumbs />`
// ABOVE `{children}`, so the deeper server pages cannot push data up to an
// ancestor consumer directly (#393 "Architectural constraint"). The store
// bridges that gap: its provider wraps both `<Breadcrumbs />` and the page
// subtree, each leaf page renders a small client `<BreadcrumbLabelRegistrar />`
// that writes its already-resolved label into the store via effect, and
// `<Breadcrumbs />` reads the store, falling back to terminology labels when
// no entry is registered.
//
// Labels are keyed by the full pathname (the leaf's own path, which equals
// the leaf crumb's accumulated href), so a registrar needs only the label —
// it reads its own path from `usePathname()`.

type LabelMap = ReadonlyMap<string, string>;

interface BreadcrumbLabelStore {
  labels: LabelMap;
  register: (path: string, label: string) => void;
  unregister: (path: string) => void;
}

const EMPTY_LABELS: LabelMap = new Map();

// A no-op default so `<Breadcrumbs />` (and unit tests) work without a
// provider mounted — reads resolve to the empty map and fall back to the
// static/terminology labels.
const BreadcrumbLabelContext = createContext<BreadcrumbLabelStore>({
  labels: EMPTY_LABELS,
  register: () => {},
  unregister: () => {},
});

export function BreadcrumbLabelProvider({ children }: { children: ReactNode }) {
  const [labels, setLabels] = useState<Map<string, string>>(() => new Map());

  const register = useCallback((path: string, label: string) => {
    setLabels((prev) => {
      if (prev.get(path) === label) return prev;
      const next = new Map(prev);
      next.set(path, label);
      return next;
    });
  }, []);

  const unregister = useCallback((path: string) => {
    setLabels((prev) => {
      if (!prev.has(path)) return prev;
      const next = new Map(prev);
      next.delete(path);
      return next;
    });
  }, []);

  const value = useMemo<BreadcrumbLabelStore>(
    () => ({ labels, register, unregister }),
    [labels, register, unregister],
  );

  return (
    <BreadcrumbLabelContext.Provider value={value}>
      {children}
    </BreadcrumbLabelContext.Provider>
  );
}

/** Read the registered labels, keyed by pathname. */
export function useBreadcrumbLabels(): LabelMap {
  return useContext(BreadcrumbLabelContext).labels;
}

/**
 * Registers `label` for the current pathname while mounted, clearing it on
 * unmount. Rendered by a leaf server page with the label resolved from its
 * already-loaded data, so the crumb needs no client-side refetch.
 */
export function BreadcrumbLabelRegistrar({ label }: { label: string }) {
  const { register, unregister } = useContext(BreadcrumbLabelContext);
  const pathname = usePathname();

  useEffect(() => {
    register(pathname, label);
    return () => unregister(pathname);
  }, [pathname, label, register, unregister]);

  return null;
}

/**
 * Registers the event-analysis crumb label as `{event time} · {kind display
 * name}` (#559), mirroring aice-web-next#746's breadcrumb. The label store is
 * string-typed and the display timezone resolves client-side (account → browser
 * → UTC), so — unlike the server-composed string `<BreadcrumbLabelRegistrar>`
 * takes — the compact time MUST be formatted here, in the browser, from the raw
 * ISO `eventTime`. Uses the same `formatDateTimeCompact` + `resolveDisplayTimeZone`
 * helpers `<Timestamp compact>` uses, so the crumb time matches the page subtitle.
 *
 * Fallbacks mirror `<EventTitle>`: `kind` null → time only; `eventTime` null
 * (no row to read it from) → the static `fallback` label (`Event` / `이벤트`),
 * never the opaque `event_key`.
 */
export function BreadcrumbEventLabelRegistrar({
  eventTime,
  kind,
  fallback,
}: {
  /** The event instant as an ISO string, or `null` to register `fallback`. */
  eventTime: string | null;
  /** Raw upstream kind (`__typename`), or `null` to register time only. */
  kind: string | null;
  /** Static localized fallback when `eventTime` is absent. */
  fallback: string;
}) {
  const { register, unregister } = useContext(BreadcrumbLabelContext);
  const pathname = usePathname();
  const accountTimezone = useAccountTimezone();
  const locale = useLocale();

  const label = useMemo(() => {
    if (eventTime === null) return fallback;
    const timeZone = resolveDisplayTimeZone(accountTimezone);
    const time = formatDateTimeCompact(eventTime, timeZone, locale);
    const displayKind = eventKindDisplayName(kind);
    return displayKind !== null ? `${time} · ${displayKind}` : time;
  }, [eventTime, kind, fallback, accountTimezone, locale]);

  useEffect(() => {
    register(pathname, label);
    return () => unregister(pathname);
  }, [pathname, label, register, unregister]);

  return null;
}
