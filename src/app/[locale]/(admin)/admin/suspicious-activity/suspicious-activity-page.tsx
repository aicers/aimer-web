"use client";

import { useFormatter, useTranslations } from "next-intl";
import { useCallback, useEffect, useRef, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { ApiError, apiFetch } from "@/lib/api/client";
import { ALL_INDICATORS } from "@/lib/detection/indicators";

interface Alert {
  id: string;
  createdAt: string;
  indicator: string;
  severity: string;
  actorId: string | null;
  ipAddress: string | null;
  summary: Record<string, unknown>;
  auditLogIds: number[];
  correlationId: string | null;
}

interface Filters {
  severity: string;
  indicator: string;
  from: string;
  to: string;
}

const INITIAL_FILTERS: Filters = {
  severity: "",
  indicator: "",
  from: "",
  to: "",
};

const DATE_TIME_FORMAT = {
  year: "numeric" as const,
  month: "2-digit" as const,
  day: "2-digit" as const,
  hour: "2-digit" as const,
  minute: "2-digit" as const,
  second: "2-digit" as const,
};

const AUTO_REFRESH_MS = 30_000;

function toISOWithOffset(datetimeLocal: string): string {
  const d = new Date(datetimeLocal);
  if (Number.isNaN(d.getTime())) return datetimeLocal;
  const offset = -d.getTimezoneOffset();
  const sign = offset >= 0 ? "+" : "-";
  const hh = String(Math.floor(Math.abs(offset) / 60)).padStart(2, "0");
  const mm = String(Math.abs(offset) % 60).padStart(2, "0");
  return `${datetimeLocal}:00${sign}${hh}:${mm}`;
}

function buildQueryString(filters: Filters, cursor: string | null): string {
  const params = new URLSearchParams();
  if (filters.severity) params.set("severity", filters.severity);
  if (filters.indicator) params.set("indicator", filters.indicator);
  if (filters.from) params.set("from", toISOWithOffset(filters.from));
  if (filters.to) params.set("to", toISOWithOffset(filters.to));
  if (cursor) params.set("cursor", cursor);
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

export function SuspiciousActivityPage() {
  const t = useTranslations("suspiciousActivity");
  const tIndicators = useTranslations("suspiciousActivity.indicators");
  const tCommon = useTranslations("common");
  const format = useFormatter();

  const [entries, setEntries] = useState<Alert[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [filters, setFilters] = useState<Filters>(INITIAL_FILTERS);
  const [activeFilters, setActiveFilters] = useState<Filters>(INITIAL_FILTERS);
  const [expandedRow, setExpandedRow] = useState<string | null>(null);
  const [summary, setSummary] = useState<{
    severe: number;
    warning: number;
  } | null>(null);

  const abortRef = useRef<AbortController | null>(null);

  const fetchAlerts = useCallback(
    async (appliedFilters: Filters, cursor: string | null, append: boolean) => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      try {
        const qs = buildQueryString(appliedFilters, cursor);
        const data = await apiFetch<{
          data: Alert[];
          nextCursor: string | null;
        }>(`/api/admin/detection/alerts${qs}`, {
          signal: controller.signal,
        });

        setEntries((prev) => (append ? [...prev, ...data.data] : data.data));
        setNextCursor(data.nextCursor);
        setError(null);
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") return;
        if (err instanceof ApiError && err.status === 401) {
          window.location.href = "/api/admin-auth/sign-in";
          return;
        }
        setError(t("errorLoading"));
      }
    },
    [t],
  );

  const fetchSummary = useCallback(async () => {
    try {
      const data = await apiFetch<{ severe: number; warning: number }>(
        "/api/admin/detection/alerts/summary",
      );
      setSummary(data);
    } catch {
      // Summary is non-critical; ignore errors
    }
  }, []);

  // Initial load + filter changes
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    (async () => {
      await Promise.all([
        fetchAlerts(activeFilters, null, false),
        fetchSummary(),
      ]);
      if (!cancelled) setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [activeFilters, fetchAlerts, fetchSummary]);

  // Auto-refresh
  useEffect(() => {
    const id = setInterval(() => {
      fetchAlerts(activeFilters, null, false);
      fetchSummary();
    }, AUTO_REFRESH_MS);
    return () => clearInterval(id);
  }, [activeFilters, fetchAlerts, fetchSummary]);

  const handleApplyFilters = () => {
    setActiveFilters({ ...filters });
  };

  const handleResetFilters = () => {
    setFilters(INITIAL_FILTERS);
    setActiveFilters(INITIAL_FILTERS);
  };

  const handleLoadMore = async () => {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    await fetchAlerts(activeFilters, nextCursor, true);
    setLoadingMore(false);
  };

  return (
    <div className="space-y-6">
      {/* Summary stats */}
      {summary && (summary.severe > 0 || summary.warning > 0) && (
        <div className="flex items-center gap-4 rounded-lg border border-border bg-muted/30 px-4 py-3">
          <span className="text-sm text-muted-foreground">{t("last24h")}</span>
          {summary.severe > 0 && (
            <Badge variant="destructive">
              {t("severeCount", { count: summary.severe })}
            </Badge>
          )}
          {summary.warning > 0 && (
            <Badge variant="warning">
              {t("warningCount", { count: summary.warning })}
            </Badge>
          )}
        </div>
      )}

      {/* Filter controls */}
      <div className="rounded-lg border border-border p-4">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Select
            value={filters.severity}
            onChange={(e) =>
              setFilters((f) => ({ ...f, severity: e.target.value }))
            }
          >
            <option value="">{t("allSeverities")}</option>
            <option value="severe">{t("severe")}</option>
            <option value="warning">{t("warning")}</option>
          </Select>

          <Select
            value={filters.indicator}
            onChange={(e) =>
              setFilters((f) => ({ ...f, indicator: e.target.value }))
            }
          >
            <option value="">{t("allIndicators")}</option>
            {ALL_INDICATORS.map((ind) => (
              <option key={ind} value={ind}>
                {tIndicators(ind)}
              </option>
            ))}
          </Select>

          <Input
            type="datetime-local"
            placeholder={t("filterFrom")}
            value={filters.from}
            onChange={(e) =>
              setFilters((f) => ({ ...f, from: e.target.value }))
            }
          />

          <div className="flex items-center gap-2">
            <Input
              type="datetime-local"
              placeholder={t("filterTo")}
              value={filters.to}
              onChange={(e) =>
                setFilters((f) => ({ ...f, to: e.target.value }))
              }
            />
            <Button type="button" size="sm" onClick={handleApplyFilters}>
              {t("apply")}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={handleResetFilters}
            >
              {t("reset")}
            </Button>
          </div>
        </div>
      </div>

      {/* Loading / error */}
      {loading && (
        <div className="flex items-center justify-center py-12">
          <p className="text-sm text-muted-foreground">{tCommon("loading")}</p>
        </div>
      )}

      {error && !loading && (
        <div className="flex items-center justify-center py-12">
          <p className="text-sm text-destructive">{error}</p>
        </div>
      )}

      {/* Table */}
      {!loading && !error && (
        <>
          {entries.length === 0 ? (
            <div className="flex items-center justify-center py-12">
              <p className="text-sm text-muted-foreground">{t("noResults")}</p>
            </div>
          ) : (
            <div className="overflow-x-auto rounded-lg border border-border">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border bg-muted/50">
                    <th className="px-4 py-3 text-left font-medium text-muted-foreground">
                      {t("createdAt")}
                    </th>
                    <th className="px-4 py-3 text-left font-medium text-muted-foreground">
                      {t("severity")}
                    </th>
                    <th className="px-4 py-3 text-left font-medium text-muted-foreground">
                      {t("indicator")}
                    </th>
                    <th className="px-4 py-3 text-left font-medium text-muted-foreground">
                      {t("actor")}
                    </th>
                    <th className="px-4 py-3 text-left font-medium text-muted-foreground">
                      {t("ipAddress")}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {entries.map((entry) => (
                    <AlertRow
                      key={entry.id}
                      entry={entry}
                      expanded={expandedRow === entry.id}
                      onToggle={() =>
                        setExpandedRow((prev) =>
                          prev === entry.id ? null : entry.id,
                        )
                      }
                      format={format}
                      t={t}
                      tIndicators={tIndicators}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* Load more */}
          {nextCursor && (
            <div className="flex justify-center pt-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={loadingMore}
                onClick={handleLoadMore}
              >
                {loadingMore ? tCommon("loading") : t("loadMore")}
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function AlertRow({
  entry,
  expanded,
  onToggle,
  format,
  t,
  tIndicators,
}: {
  entry: Alert;
  expanded: boolean;
  onToggle: () => void;
  format: ReturnType<typeof useFormatter>;
  t: ReturnType<typeof useTranslations<"suspiciousActivity">>;
  tIndicators: ReturnType<
    typeof useTranslations<"suspiciousActivity.indicators">
  >;
}) {
  return (
    <>
      <tr
        className="cursor-pointer border-b border-border last:border-b-0 hover:bg-muted/30"
        onClick={onToggle}
      >
        <td className="px-4 py-3 text-muted-foreground whitespace-nowrap">
          {format.dateTime(new Date(entry.createdAt), DATE_TIME_FORMAT)}
        </td>
        <td className="px-4 py-3">
          <Badge
            variant={entry.severity === "severe" ? "destructive" : "warning"}
          >
            {t(entry.severity as "severe" | "warning")}
          </Badge>
        </td>
        <td className="px-4 py-3">
          <Badge variant="secondary">
            {tIndicators(entry.indicator as Parameters<typeof tIndicators>[0])}
          </Badge>
        </td>
        <td className="px-4 py-3">
          {entry.actorId ? (
            <code className="text-xs">{truncateId(entry.actorId)}</code>
          ) : (
            "—"
          )}
        </td>
        <td className="px-4 py-3 text-muted-foreground">
          {entry.ipAddress ?? "—"}
        </td>
      </tr>
      {expanded && (
        <tr className="border-b border-border last:border-b-0">
          <td colSpan={5} className="bg-muted/20 px-4 py-3">
            <div className="space-y-1">
              <p className="text-xs font-medium text-muted-foreground">
                {t("summary")}
              </p>
              <pre className="overflow-x-auto rounded bg-muted p-3 text-xs text-foreground">
                {JSON.stringify(entry.summary, null, 2)}
              </pre>
              {entry.auditLogIds.length > 0 && (
                <p className="text-xs text-muted-foreground">
                  {t("auditLogIds")}:{" "}
                  <code>{entry.auditLogIds.join(", ")}</code>
                </p>
              )}
              {entry.correlationId && (
                <p className="text-xs text-muted-foreground">
                  Correlation ID: <code>{entry.correlationId}</code>
                </p>
              )}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

function truncateId(id: string): string {
  if (id.length <= 12) return id;
  return `${id.slice(0, 8)}…`;
}
