"use client";

import { useFormatter, useTranslations } from "next-intl";
import { useCallback, useEffect, useRef, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { ApiError, apiFetch } from "@/lib/api/client";

interface AuditLogEntry {
  id: string;
  timestamp: string;
  actorId: string;
  authContext: string | null;
  action: string;
  targetType: string;
  targetId: string | null;
  details: Record<string, unknown> | null;
  ipAddress: string | null;
  sid: string | null;
  customerId: string | null;
  aiceId: string | null;
  correlationId: string | null;
}

interface Filters {
  authContext: string;
  action: string;
  actorId: string;
  customerId: string;
  aiceId: string;
  from: string;
  to: string;
}

const INITIAL_FILTERS: Filters = {
  authContext: "",
  action: "",
  actorId: "",
  customerId: "",
  aiceId: "",
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

/** Append the browser's timezone offset to a datetime-local value so the
 *  server can interpret it correctly as timestamptz. */
function toISOWithOffset(datetimeLocal: string): string {
  const d = new Date(datetimeLocal);
  if (Number.isNaN(d.getTime())) return datetimeLocal;
  const offset = -d.getTimezoneOffset();
  const sign = offset >= 0 ? "+" : "-";
  const hh = String(Math.floor(Math.abs(offset) / 60)).padStart(2, "0");
  const mm = String(Math.abs(offset) % 60).padStart(2, "0");
  return `${datetimeLocal}:00${sign}${hh}:${mm}`;
}

function buildQueryString(
  filters: Filters,
  cursor: string | null,
  correlationId: string | null,
): string {
  const params = new URLSearchParams();
  if (filters.authContext) params.set("auth_context", filters.authContext);
  if (filters.action) params.set("action", filters.action);
  if (filters.actorId) params.set("actor_id", filters.actorId);
  if (filters.customerId) params.set("customer_id", filters.customerId);
  if (filters.aiceId) params.set("aice_id", filters.aiceId);
  if (filters.from) params.set("from", toISOWithOffset(filters.from));
  if (filters.to) params.set("to", toISOWithOffset(filters.to));
  if (correlationId) params.set("correlation_id", correlationId);
  if (cursor) params.set("cursor", cursor);
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

export function AuditLogsPage() {
  const t = useTranslations("auditLogs");
  const tCommon = useTranslations("common");
  const format = useFormatter();

  const [entries, setEntries] = useState<AuditLogEntry[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [filters, setFilters] = useState<Filters>(INITIAL_FILTERS);
  const [activeFilters, setActiveFilters] = useState<Filters>(INITIAL_FILTERS);
  const [correlationFilter, setCorrelationFilter] = useState<string | null>(
    null,
  );
  const [expandedRow, setExpandedRow] = useState<string | null>(null);

  const abortRef = useRef<AbortController | null>(null);

  const fetchLogs = useCallback(
    async (
      appliedFilters: Filters,
      cursor: string | null,
      corrId: string | null,
      append: boolean,
    ) => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      try {
        const qs = buildQueryString(appliedFilters, cursor, corrId);
        const data = await apiFetch<{
          data: AuditLogEntry[];
          nextCursor: string | null;
        }>(`/api/admin/audit-logs${qs}`);

        if (controller.signal.aborted) return;

        setEntries((prev) => (append ? [...prev, ...data.data] : data.data));
        setNextCursor(data.nextCursor);
        setError(null);
      } catch (err) {
        if (controller.signal.aborted) return;
        if (err instanceof ApiError && err.status === 401) {
          window.location.href = "/api/admin-auth/sign-in";
          return;
        }
        setError(t("errorLoading"));
      }
    },
    [t],
  );

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    (async () => {
      await fetchLogs(activeFilters, null, correlationFilter, false);
      if (!cancelled) setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [activeFilters, correlationFilter, fetchLogs]);

  const handleApplyFilters = () => {
    setCorrelationFilter(null);
    setActiveFilters({ ...filters });
  };

  const handleResetFilters = () => {
    setFilters(INITIAL_FILTERS);
    setCorrelationFilter(null);
    setActiveFilters(INITIAL_FILTERS);
  };

  const handleLoadMore = async () => {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    await fetchLogs(activeFilters, nextCursor, correlationFilter, true);
    setLoadingMore(false);
  };

  const handleCorrelationClick = (corrId: string) => {
    setFilters(INITIAL_FILTERS);
    setActiveFilters(INITIAL_FILTERS);
    setCorrelationFilter(corrId);
  };

  const handleClearCorrelation = () => {
    setCorrelationFilter(null);
  };

  return (
    <div className="space-y-6">
      {/* Correlation filter banner */}
      {correlationFilter && (
        <div className="flex items-center gap-3 rounded-md border border-border bg-muted/50 px-4 py-3">
          <span className="text-sm text-muted-foreground">
            {t("correlationId")}:
          </span>
          <Badge variant="outline">
            <code className="text-xs">{correlationFilter}</code>
          </Badge>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            onClick={handleClearCorrelation}
          >
            {t("clearCorrelation")}
          </Button>
        </div>
      )}

      {/* Filter controls */}
      <div className="rounded-md border border-border p-4">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Select
            value={filters.authContext}
            onChange={(e) =>
              setFilters((f) => ({ ...f, authContext: e.target.value }))
            }
          >
            <option value="">{t("allContexts")}</option>
            <option value="general">{t("general")}</option>
            <option value="admin">{t("admin")}</option>
          </Select>

          <Input
            type="text"
            placeholder={t("filterAction")}
            value={filters.action}
            onChange={(e) =>
              setFilters((f) => ({ ...f, action: e.target.value }))
            }
          />

          <Input
            type="text"
            placeholder={t("filterActorId")}
            value={filters.actorId}
            onChange={(e) =>
              setFilters((f) => ({ ...f, actorId: e.target.value }))
            }
          />

          <Input
            type="text"
            placeholder={t("filterCustomerId")}
            value={filters.customerId}
            onChange={(e) =>
              setFilters((f) => ({ ...f, customerId: e.target.value }))
            }
          />

          <Input
            type="text"
            placeholder={t("filterAiceId")}
            value={filters.aiceId}
            onChange={(e) =>
              setFilters((f) => ({ ...f, aiceId: e.target.value }))
            }
          />

          <Input
            type="datetime-local"
            placeholder={t("filterFrom")}
            value={filters.from}
            onChange={(e) =>
              setFilters((f) => ({ ...f, from: e.target.value }))
            }
          />

          <Input
            type="datetime-local"
            placeholder={t("filterTo")}
            value={filters.to}
            onChange={(e) => setFilters((f) => ({ ...f, to: e.target.value }))}
          />

          <div className="flex items-center gap-2">
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
            <div className="overflow-x-auto rounded-md border border-border">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border bg-muted/50">
                    <th className="px-3 py-3 text-left font-medium text-muted-foreground">
                      {t("timestamp")}
                    </th>
                    <th className="px-3 py-3 text-left font-medium text-muted-foreground">
                      {t("actor")}
                    </th>
                    <th className="px-3 py-3 text-left font-medium text-muted-foreground">
                      {t("action")}
                    </th>
                    <th className="px-3 py-3 text-left font-medium text-muted-foreground">
                      {t("target")}
                    </th>
                    <th className="px-3 py-3 text-left font-medium text-muted-foreground">
                      {t("authContext")}
                    </th>
                    <th className="px-3 py-3 text-left font-medium text-muted-foreground">
                      {t("ipAddress")}
                    </th>
                    <th className="px-3 py-3 text-left font-medium text-muted-foreground">
                      {t("correlationId")}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {entries.map((entry) => (
                    <AuditLogRow
                      key={entry.id}
                      entry={entry}
                      expanded={expandedRow === entry.id}
                      onToggle={() =>
                        setExpandedRow((prev) =>
                          prev === entry.id ? null : entry.id,
                        )
                      }
                      onCorrelationClick={handleCorrelationClick}
                      format={format}
                      t={t}
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

function AuditLogRow({
  entry,
  expanded,
  onToggle,
  onCorrelationClick,
  format,
  t,
}: {
  entry: AuditLogEntry;
  expanded: boolean;
  onToggle: () => void;
  onCorrelationClick: (id: string) => void;
  format: ReturnType<typeof useFormatter>;
  t: ReturnType<typeof useTranslations<"auditLogs">>;
}) {
  const targetDisplay = entry.targetId
    ? `${entry.targetType}/${entry.targetId}`
    : entry.targetType;

  return (
    <>
      <tr
        className="cursor-pointer border-b border-border last:border-b-0 hover:bg-muted/30"
        onClick={onToggle}
      >
        <td className="px-3 py-3.5 text-muted-foreground whitespace-nowrap">
          {format.dateTime(new Date(entry.timestamp), DATE_TIME_FORMAT)}
        </td>
        <td className="px-3 py-3.5">
          <code className="text-xs">{truncateId(entry.actorId)}</code>
        </td>
        <td className="px-3 py-3.5">
          <Badge variant="secondary">{entry.action}</Badge>
        </td>
        <td className="px-3 py-3.5 text-muted-foreground">
          <code className="text-xs">{targetDisplay}</code>
        </td>
        <td className="px-3 py-3.5">
          {entry.authContext && (
            <Badge
              variant={
                entry.authContext === "admin" ? "destructive" : "default"
              }
            >
              {t(entry.authContext as "general" | "admin")}
            </Badge>
          )}
        </td>
        <td className="px-3 py-3.5 text-muted-foreground">
          {entry.ipAddress ?? "—"}
        </td>
        <td className="px-3 py-3.5">
          {entry.correlationId ? (
            <Button
              type="button"
              variant="link"
              size="xs"
              title={t("viewCorrelation")}
              onClick={(e) => {
                e.stopPropagation();
                if (entry.correlationId) {
                  onCorrelationClick(entry.correlationId);
                }
              }}
            >
              <code className="text-xs">
                {entry.correlationId.slice(0, 8)}…
              </code>
            </Button>
          ) : (
            "—"
          )}
        </td>
      </tr>
      {expanded && (
        <tr className="border-b border-border last:border-b-0">
          <td colSpan={7} className="bg-muted/20 px-3 py-3.5">
            <div className="space-y-1">
              {entry.details && (
                <>
                  <p className="text-xs font-medium text-muted-foreground">
                    {t("details")}
                  </p>
                  <pre className="overflow-x-auto rounded bg-muted p-3 text-xs text-foreground">
                    {JSON.stringify(entry.details, null, 2)}
                  </pre>
                </>
              )}
              {entry.sid && (
                <p className="text-xs text-muted-foreground">
                  SID: <code>{entry.sid}</code>
                </p>
              )}
              {entry.customerId && (
                <p className="text-xs text-muted-foreground">
                  {t("customerId")}: <code>{entry.customerId}</code>
                </p>
              )}
              {entry.aiceId && (
                <p className="text-xs text-muted-foreground">
                  {t("aiceId")}: <code>{entry.aiceId}</code>
                </p>
              )}
              {entry.correlationId && (
                <p className="text-xs text-muted-foreground">
                  {t("correlationId")}: <code>{entry.correlationId}</code>
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
