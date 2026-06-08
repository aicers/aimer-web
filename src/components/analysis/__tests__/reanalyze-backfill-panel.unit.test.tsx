// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Render translation keys with interpolated vars so assertions can target
// the variable values the panel computes.
const t = (key: string, vars?: Record<string, unknown>) =>
  vars ? `${key}:${JSON.stringify(vars)}` : key;
vi.mock("next-intl", () => ({ useTranslations: () => t }));

import { ReanalyzeBackfillPanel } from "../reanalyze-backfill-panel";

const PREVIEW = {
  scope: { modelName: "openai", model: "gpt-5.5", windowDays: 7, cap: null },
  counts: {
    seeded: 4,
    requeued: 1,
    coalesced: 2,
    skipped_dirty: 1,
    source_unavailable: 0,
    cap_excluded: 0,
  },
};

const EMPTY_PREVIEW = {
  scope: { modelName: "openai", model: "gpt-5.5", windowDays: 7, cap: null },
  counts: {
    seeded: 0,
    requeued: 0,
    coalesced: 3,
    skipped_dirty: 0,
    source_unavailable: 0,
    cap_excluded: 0,
  },
};

afterEach(() => cleanup());

describe("ReanalyzeBackfillPanel", () => {
  let fetcher: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetcher = vi.fn();
  });

  it("loads the default-scope preview on mount and shows the leaf count", async () => {
    fetcher.mockResolvedValueOnce(PREVIEW);
    render(
      <ReanalyzeBackfillPanel
        apiBase="/api/x/reanalyze"
        fetcher={fetcher as never}
      />,
    );

    await waitFor(() =>
      expect(fetcher).toHaveBeenCalledWith(
        "/api/x/reanalyze/preview?windowDays=7",
      ),
    );
    // toEnqueue = seeded + requeued = 5.
    await waitFor(() => expect(screen.getByText("5")).toBeDefined());
  });

  it("gates the run behind explicit confirmation, then POSTs confirm:true", async () => {
    fetcher.mockResolvedValueOnce(PREVIEW); // preview on mount
    render(
      <ReanalyzeBackfillPanel
        apiBase="/api/x/reanalyze"
        fetcher={fetcher as never}
      />,
    );
    await waitFor(() => expect(screen.getByText("5")).toBeDefined());

    const start = screen.getByText("startButton").closest("button");
    if (!start) throw new Error("start button not found");
    // Disabled until the operator confirms.
    expect(start.hasAttribute("disabled")).toBe(true);

    // The confirm checkbox is the one whose className marks it (mt-1).
    const confirmBox = screen
      .getAllByRole("checkbox")
      .find((c) => (c as HTMLInputElement).className.includes("mt-1"));
    if (!confirmBox) throw new Error("confirm checkbox not found");
    fireEvent.click(confirmBox);
    expect(start.hasAttribute("disabled")).toBe(false);

    // run POST → then a status refresh.
    fetcher
      .mockResolvedValueOnce({ counts: { ...PREVIEW.counts } })
      .mockResolvedValueOnce({
        totalLeaves: 5,
        outstanding: 5,
        drained: false,
        counts: {},
      });
    fireEvent.click(start);

    await waitFor(() =>
      expect(screen.getByText("enqueuedTitle")).toBeDefined(),
    );
    const postCall = fetcher.mock.calls.find((c) => c[1]?.method === "POST");
    expect(postCall).toBeDefined();
    expect(JSON.parse(postCall?.[1].body)).toMatchObject({
      confirm: true,
      windowDays: 7,
    });
  });

  it("disables the run when there is nothing to enqueue", async () => {
    fetcher.mockResolvedValueOnce(EMPTY_PREVIEW);
    render(
      <ReanalyzeBackfillPanel
        apiBase="/api/x/reanalyze"
        fetcher={fetcher as never}
      />,
    );

    await waitFor(() =>
      expect(screen.getByText("nothingToEnqueue")).toBeDefined(),
    );
    const start = screen.getByText("startButton").closest("button");
    expect(start?.hasAttribute("disabled")).toBe(true);
  });
});
