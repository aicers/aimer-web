// @vitest-environment jsdom
//
// #369 — periodic report index/landing page. Verifies:
//   - period sections render in LIVE → DAILY → WEEKLY → MONTHLY order
//   - each bucket links into the detail page with `?tz=<state.tz>` pinned
//   - result presence drives the status hint + priority badge
//   - dirty state shows the "Updating" hint
//   - empty discovery shows the empty banner
//   - unauthorized → notFound (404); forbidden → forbidden (403)

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReportIndexPageOutcome } from "@/lib/analysis/report-index-page-loader";

const mockLoad = vi.fn<() => Promise<ReportIndexPageOutcome>>();

vi.mock("@/lib/analysis/report-index-page-loader", () => ({
  loadReportIndexPage: () => mockLoad(),
}));

// The index resolves the subject kind (#513) before loading; stub it to
// `"customer"` and the auth pool so importing the page in jsdom does not pull
// `server-only` / `pg`.
vi.mock("@/lib/db/client", () => ({ getAuthPool: () => ({}) }));
vi.mock("@/lib/db/subject-runtime-pool", () => ({
  getSubjectKind: async () => "customer",
}));

vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
  forbidden: () => {
    throw new Error("NEXT_FORBIDDEN");
  },
}));

vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    ...props
  }: {
    href: string;
    children: React.ReactNode;
  }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

vi.mock("next-intl/server", async () => {
  const { createTranslator } = await import("next-intl");
  const messages = (await import("@/i18n/messages/en.json")).default;
  return {
    getTranslations: async (namespace?: string) =>
      createTranslator({
        locale: "en",
        messages,
        namespace: namespace as never,
      }),
  };
});

import ReportIndexPage from "../page";

const CUSTOMER_ID = "c0000000-0000-0000-0000-000000000001";

function okFixture(): ReportIndexPageOutcome {
  return {
    kind: "ok",
    groups: [
      {
        period: "LIVE",
        items: [
          {
            period: "LIVE",
            bucketDate: "1970-01-01",
            tz: "Asia/Seoul",
            stateStatus: "ready",
            result: {
              priorityTier: "HIGH",
              generation: 3,
              requestedBy: null,
              requestedAt: new Date("2026-05-27T12:00:00Z"),
            },
            availableLocales: ["en", "ko"],
            resolvedLocale: "en",
          },
        ],
      },
      {
        period: "DAILY",
        items: [
          {
            period: "DAILY",
            bucketDate: "2026-05-27",
            tz: "Asia/Seoul",
            stateStatus: "ready",
            result: {
              priorityTier: "MEDIUM",
              generation: 1,
              requestedBy: null,
              requestedAt: new Date("2026-05-27T12:00:00Z"),
            },
            availableLocales: ["en"],
            resolvedLocale: "en",
          },
          {
            period: "DAILY",
            bucketDate: "2026-05-26",
            tz: "Asia/Seoul",
            stateStatus: "pending",
            result: null,
            availableLocales: [],
            resolvedLocale: null,
          },
        ],
      },
    ],
  };
}

async function renderPage(): Promise<void> {
  const jsx = await ReportIndexPage({
    params: Promise.resolve({ locale: "en", subjectId: CUSTOMER_ID }),
  });
  render(jsx);
}

describe("report index page", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLoad.mockResolvedValue(okFixture());
  });
  afterEach(() => cleanup());

  it("renders a section per period present", async () => {
    await renderPage();
    expect(screen.getByTestId("period-section-LIVE")).toBeTruthy();
    expect(screen.getByTestId("period-section-DAILY")).toBeTruthy();
  });

  it("pins ?tz=<state.tz> on each detail link", async () => {
    await renderPage();
    const live = screen.getByTestId("report-link-LIVE-1970-01-01");
    expect(live.getAttribute("href")).toBe(
      `/en/subjects/${CUSTOMER_ID}/analysis/reports/LIVE/1970-01-01?tz=Asia%2FSeoul`,
    );
    const daily = screen.getByTestId("report-link-DAILY-2026-05-27");
    expect(daily.getAttribute("href")).toContain(
      "/reports/DAILY/2026-05-27?tz=Asia%2FSeoul",
    );
  });

  it("shows the priority badge and Ready hint when a result exists", async () => {
    await renderPage();
    expect(
      screen
        .getByTestId("report-status-DAILY-2026-05-27")
        .getAttribute("data-status"),
    ).toBe("Ready");
    // The LIVE card carries a HIGH-tier badge from its result.
    expect(
      screen.getAllByTestId("priority-tier-badge")[0].getAttribute("data-tier"),
    ).toBe("HIGH");
  });

  it("renders per-bucket available-language chips", async () => {
    await renderPage();
    const live = screen.getByTestId("report-langs-LIVE-1970-01-01");
    expect(
      Array.from(live.querySelectorAll("[data-locale]")).map((el) =>
        el.getAttribute("data-locale"),
      ),
    ).toEqual(["en", "ko"]);
    // A bucket with no result has no language chips.
    expect(screen.queryByTestId("report-langs-DAILY-2026-05-26")).toBeNull();
  });

  it("shows the being-generated hint when no result exists", async () => {
    await renderPage();
    expect(
      screen
        .getByTestId("report-status-DAILY-2026-05-26")
        .getAttribute("data-status"),
    ).toBe("Being generated");
  });

  it("shows the updating hint for a dirty bucket", async () => {
    mockLoad.mockResolvedValue({
      kind: "ok",
      groups: [
        {
          period: "WEEKLY",
          items: [
            {
              period: "WEEKLY",
              bucketDate: "2026-05-25",
              tz: "UTC",
              stateStatus: "dirty",
              result: {
                priorityTier: "LOW",
                generation: 2,
                requestedBy: null,
                requestedAt: new Date("2026-05-26T00:00:00Z"),
              },
              availableLocales: ["en"],
              resolvedLocale: "en",
            },
          ],
        },
      ],
    });
    await renderPage();
    expect(
      screen
        .getByTestId("report-status-WEEKLY-2026-05-25")
        .getAttribute("data-status"),
    ).toBe("Updating");
  });

  it("renders the empty banner when no buckets are discovered", async () => {
    mockLoad.mockResolvedValue({ kind: "ok", groups: [] });
    await renderPage();
    expect(screen.getByTestId("reports-empty")).toBeTruthy();
  });

  it("404s when the loader reports unauthorized", async () => {
    mockLoad.mockResolvedValue({ kind: "unauthorized" });
    await expect(renderPage()).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("403s (real status) when the loader reports forbidden", async () => {
    mockLoad.mockResolvedValue({ kind: "forbidden" });
    await expect(renderPage()).rejects.toThrow("NEXT_FORBIDDEN");
  });
});
