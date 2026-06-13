// #576 — thin calendar data endpoint. Verifies it reuses the loader's status
// mapping (unauthorized → 404, forbidden → 403, ok → data), resolves and
// forwards the subject kind (null → 404; group → group path, never the
// customer default), and validates the period / viewport before loading.

import type { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CalendarPageOutcome } from "@/lib/analysis/report-calendar-loader";

vi.mock("server-only", () => ({}));

const mockLoad = vi.fn<(input: unknown) => Promise<CalendarPageOutcome>>();
vi.mock("@/lib/analysis/report-calendar-loader", () => ({
  loadReportCalendarPage: (input: unknown) => mockLoad(input),
}));

const mockSubjectKind = vi.fn<() => Promise<"customer" | "group" | null>>();
vi.mock("@/lib/db/subject-runtime-pool", () => ({
  getSubjectKind: () => mockSubjectKind(),
}));

vi.mock("@/lib/db/client", () => ({ getAuthPool: () => ({}) }));
vi.mock("@/lib/instrumentation/time", () => ({
  getCurrentTimestamp: () => new Date("2026-06-13T00:00:00Z"),
}));

const { GET } = await import("../route");

const SUBJECT = "c0000000-0000-0000-0000-000000000001";

function req(period: string, query = ""): NextRequest {
  const url = `https://x/api/subjects/${SUBJECT}/analysis/report/${period}/calendar${query}`;
  return { nextUrl: new URL(url) } as unknown as NextRequest;
}

function okOutcome(): Extract<CalendarPageOutcome, { kind: "ok" }> {
  return {
    kind: "ok",
    data: {
      period: "DAILY",
      viewport: { kind: "month", year: 2026, month: 5 },
      oldestNavigableDate: null,
      today: "2026-06-13",
      cells: [],
    },
  };
}

beforeEach(() => {
  mockLoad.mockReset();
  mockSubjectKind.mockReset();
  mockSubjectKind.mockResolvedValue("customer");
});

describe("calendar route handler", () => {
  it("returns the loader data and forwards the resolved subject kind + viewport", async () => {
    mockLoad.mockResolvedValue(okOutcome());
    const res = await GET(req("DAILY", "?month=2026-05"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: okOutcome().data });

    const arg = mockLoad.mock.calls[0][0];
    expect(arg).toMatchObject({
      subjectId: SUBJECT,
      period: "DAILY",
      subjectKind: "customer",
      viewport: { kind: "month", year: 2026, month: 5 },
    });
  });

  it("passes the GROUP kind to the loader, never the customer default", async () => {
    mockSubjectKind.mockResolvedValue("group");
    mockLoad.mockResolvedValue(okOutcome());
    await GET(req("MONTHLY", "?year=2026"));

    const arg = mockLoad.mock.calls[0][0];
    expect(arg).toMatchObject({
      subjectKind: "group",
      period: "MONTHLY",
      viewport: { kind: "year", year: 2026 },
    });
  });

  it("maps unauthorized → 404 and forbidden → 403", async () => {
    mockLoad.mockResolvedValue({ kind: "unauthorized" });
    expect((await GET(req("DAILY", "?month=2026-05"))).status).toBe(404);

    mockLoad.mockResolvedValue({ kind: "forbidden" });
    expect((await GET(req("DAILY", "?month=2026-05"))).status).toBe(403);
  });

  it("404s when the subject kind is null, without loading", async () => {
    mockSubjectKind.mockResolvedValue(null);
    const res = await GET(req("DAILY", "?month=2026-05"));
    expect(res.status).toBe(404);
    expect(mockLoad).not.toHaveBeenCalled();
  });

  it("404s the LIVE period (no calendar) before resolving anything", async () => {
    const res = await GET(req("LIVE", "?month=2026-05"));
    expect(res.status).toBe(404);
    expect(mockSubjectKind).not.toHaveBeenCalled();
    expect(mockLoad).not.toHaveBeenCalled();
  });

  it("404s a malformed viewport param", async () => {
    const res = await GET(req("DAILY", "?month=2026-13"));
    expect(res.status).toBe(404);
    expect(mockLoad).not.toHaveBeenCalled();
  });
});
