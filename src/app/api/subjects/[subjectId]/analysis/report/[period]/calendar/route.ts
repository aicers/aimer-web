// RFC 0004 (#576) — thin calendar data endpoint backing the in-context
// calendar popover.
//
// `GET /api/subjects/{subject_id}/analysis/report/{period}/calendar?month=…|year=…`
//
// Returns the same `ReportCalendarData` the standalone calendar page renders,
// for one viewport, so the popover can fetch a viewport on open and on each
// prev/next WITHOUT a full page navigation. It is deliberately THIN: it reuses
// `loadReportCalendarPage` and its status mapping (`unauthorized → 404`,
// `forbidden → 403`) verbatim — authorization (subject-kind resolution, group
// result DB, retention boundary, existence-hiding) is the loader's job and is
// NOT reimplemented here.
//
// The handler resolves the subject kind itself via `getSubjectKind` and passes
// it to the loader (404 when null). The loader's `subjectKind` defaults to
// `"customer"`, so a handler that omitted it would make a GROUP's calendar
// silently read the customer path — this endpoint must not rely on that
// default.

import type { NextRequest } from "next/server";
import {
  type CalendarPeriod,
  loadReportCalendarPage,
} from "@/lib/analysis/report-calendar-loader";
import { resolveViewport } from "@/lib/analysis/report-calendar-viewport";
import { getAuthPool } from "@/lib/db/client";
import { getSubjectKind } from "@/lib/db/subject-runtime-pool";
import { getCurrentTimestamp } from "@/lib/instrumentation/time";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Calendar periods only — LIVE is the rolling "now" bucket and has no calendar
// (uppercase case-lock, matching the page routes).
const CALENDAR_PERIODS = new Set<CalendarPeriod>([
  "DAILY",
  "WEEKLY",
  "MONTHLY",
]);

// `subjectId` and `period` from `/api/subjects/{id}/analysis/report/{period}/calendar`.
function extractPathParts(
  req: NextRequest,
): { subjectId: string; period: CalendarPeriod } | null {
  const segments = req.nextUrl.pathname.split("/");
  const subjIdx = segments.indexOf("subjects");
  const reportIdx = segments.indexOf("report");
  if (subjIdx === -1 || reportIdx === -1) return null;
  const subjectId = segments[subjIdx + 1];
  const period = segments[reportIdx + 1];
  if (!subjectId || !UUID_RE.test(subjectId)) return null;
  if (!CALENDAR_PERIODS.has(period as CalendarPeriod)) return null;
  return { subjectId, period: period as CalendarPeriod };
}

export async function GET(req: NextRequest): Promise<Response> {
  const parts = extractPathParts(req);
  if (!parts) {
    return Response.json({ error: "not_found" }, { status: 404 });
  }
  const { subjectId, period } = parts;

  const viewport = resolveViewport(
    period,
    (name) => req.nextUrl.searchParams.get(name) ?? undefined,
    getCurrentTimestamp(),
  );
  if (viewport === null) {
    return Response.json({ error: "invalid_viewport" }, { status: 404 });
  }

  // Resolve the subject kind ourselves and pass it to the loader so a group's
  // calendar reads the group result DB with all-member authorization — never
  // the loader's `"customer"` default. An unknown subject 404s (existence-
  // hiding), matching the page routes.
  const kind = await getSubjectKind(getAuthPool(), subjectId);
  if (kind === null) {
    return Response.json({ error: "not_found" }, { status: 404 });
  }

  const outcome = await loadReportCalendarPage({
    subjectId,
    period,
    viewport,
    subjectKind: kind,
  });

  // Reuse the loader's status mapping verbatim: unauthorized → 404
  // (existence-hiding), forbidden → 403.
  if (outcome.kind === "unauthorized") {
    return Response.json({ error: "not_found" }, { status: 404 });
  }
  if (outcome.kind === "forbidden") {
    return Response.json({ error: "forbidden" }, { status: 403 });
  }
  return Response.json({ data: outcome.data });
}
