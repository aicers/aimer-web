// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Render translation keys with interpolated vars so assertions can target the
// values the panel computes.
const t = (key: string, vars?: Record<string, unknown>) =>
  vars ? `${key}:${JSON.stringify(vars)}` : key;
vi.mock("next-intl", () => ({
  useTranslations: () => t,
  useLocale: () => "en",
}));

import { ReportVariantRefreshPanel } from "../report-variant-refresh-panel";

const PREVIEW = {
  target: { lang: "ENGLISH", modelName: "openai", model: "gpt-5.5" },
  windowDays: 7,
  tz: null,
  counts: {
    totalVariants: 5,
    refreshed: 3,
    capped: 0,
    gated: 1,
    alreadyQueued: 1,
    sourceUnavailable: 0,
    limited: 0,
  },
};

const RUN = {
  id: "run-1",
  status: "completed",
  lang: "ENGLISH",
  modelName: "openai",
  model: "gpt-5.5",
  tz: null,
  windowDays: 7,
  totalVariants: 5,
  refreshed: 3,
  capped: 0,
  gated: 1,
  alreadyQueued: 1,
  sourceUnavailable: 0,
  limited: 0,
};

// Route fetches by URL/method: preview GET, last-run GET (bare base), run POST.
function makeFetcher() {
  return vi.fn((url: string, opts?: RequestInit) => {
    if (typeof url === "string" && url.includes("/preview")) {
      return Promise.resolve(PREVIEW);
    }
    if (opts?.method === "POST") return Promise.resolve({ run: RUN });
    return Promise.resolve({ runs: [] });
  });
}

const BASE = "/api/admin/customers/c1/report-refresh";

afterEach(() => cleanup());

describe("ReportVariantRefreshPanel", () => {
  let fetcher: ReturnType<typeof makeFetcher>;

  beforeEach(() => {
    fetcher = makeFetcher();
  });

  it("posts the previewed scope snapshot, not the live form, on confirm", async () => {
    render(
      <ReportVariantRefreshPanel
        customerId="c1"
        apiBase={BASE}
        fetcher={fetcher as never}
      />,
    );

    // Default-scope preview loads on mount (7-day window, all periods).
    await waitFor(() =>
      expect(screen.getByText('refreshButton:{"n":3}')).toBeDefined(),
    );

    fireEvent.click(screen.getByText('refreshButton:{"n":3}'));
    fireEvent.click(screen.getByText("confirmProceed"));

    await waitFor(() => {
      const post = fetcher.mock.calls.find((c) => c[1]?.method === "POST");
      expect(post).toBeDefined();
    });
    const post = fetcher.mock.calls.find((c) => c[1]?.method === "POST");
    expect(JSON.parse(post?.[1]?.body as string)).toEqual({
      windowDays: 7,
      lang: "ENGLISH",
      periods: ["LIVE", "DAILY", "WEEKLY", "MONTHLY"],
      confirm: true,
    });
  });

  it("invalidates an open confirmation when the scope is edited", async () => {
    render(
      <ReportVariantRefreshPanel
        customerId="c1"
        apiBase={BASE}
        fetcher={fetcher as never}
      />,
    );
    await waitFor(() =>
      expect(screen.getByText('refreshButton:{"n":3}')).toBeDefined(),
    );

    // Open the confirmation for the previewed scope.
    fireEvent.click(screen.getByText('refreshButton:{"n":3}'));
    expect(screen.getByText("confirmProceed")).toBeDefined();

    // Edit the timezone scope while confirming. This must drop the open
    // confirmation (so the operator cannot Proceed against stale counts) and
    // request a fresh preview for the new scope.
    const tzInput = document.getElementById(
      "report-refresh-tz",
    ) as HTMLInputElement;
    fireEvent.change(tzInput, { target: { value: "America/New_York" } });

    await waitFor(() =>
      expect(screen.queryByText("confirmProceed")).toBeNull(),
    );
    // No POST happened — the confirmation was invalidated before any submit.
    expect(fetcher.mock.calls.every((c) => c[1]?.method !== "POST")).toBe(true);
    // A fresh preview was requested for the edited (tz) scope.
    await waitFor(() =>
      expect(
        fetcher.mock.calls.some(
          (c) =>
            typeof c[0] === "string" &&
            c[0].includes("/preview") &&
            c[0].includes("tz=America%2FNew_York"),
        ),
      ).toBe(true),
    );
  });
});
