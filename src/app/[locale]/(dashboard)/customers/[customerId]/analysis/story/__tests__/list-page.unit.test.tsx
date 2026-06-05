// @vitest-environment jsdom
//
// WS3 (#392) — Threat Stories list page. Verifies:
//   - rows link to the story detail page WITHOUT variant params
//   - the "Updating" hint shows for dirty rows
//   - the empty banner shows when no stories match
//   - the next-page link carries the cursor + active filters
//   - unauthorized → notFound (404); forbidden → forbidden (403)

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StoryListPageOutcome } from "@/lib/analysis/story-list-page-loader";

const mockLoad = vi.fn<() => Promise<StoryListPageOutcome>>();

vi.mock("@/lib/analysis/story-list-page-loader", () => ({
  loadStoryListPage: () => mockLoad(),
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

import ThreatStoryListPage from "../page";

const CUSTOMER_ID = "c0000000-0000-0000-0000-000000000001";

async function renderPage(
  searchParams: Record<string, string> = {},
): Promise<void> {
  const jsx = await ThreatStoryListPage({
    params: Promise.resolve({ locale: "en", customerId: CUSTOMER_ID }),
    searchParams: Promise.resolve(searchParams),
  });
  render(jsx);
}

describe("threat stories list page", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLoad.mockResolvedValue({
      kind: "ok",
      page: {
        items: [
          {
            storyId: "42",
            priorityTier: "CRITICAL",
            severityScore: 0.9,
            likelihoodScore: 0.8,
            status: "ready",
            recencyTs: new Date("2026-05-27T12:00:00Z"),
          },
          {
            storyId: "7",
            priorityTier: "LOW",
            severityScore: 0.1,
            likelihoodScore: 0.2,
            status: "dirty",
            recencyTs: new Date("2026-05-26T12:00:00Z"),
          },
        ],
        nextCursor: null,
      },
    });
  });
  afterEach(() => cleanup());

  it("links rows to the story detail page with no variant params", async () => {
    await renderPage();
    expect(screen.getByTestId("story-link-42").getAttribute("href")).toBe(
      `/en/customers/${CUSTOMER_ID}/analysis/story/42`,
    );
  });

  it("shows the Updating hint only for dirty rows", async () => {
    await renderPage();
    expect(screen.getByTestId("story-status-7")).toBeTruthy();
    expect(screen.queryByTestId("story-status-42")).toBeNull();
  });

  it("renders the empty banner when no stories match", async () => {
    mockLoad.mockResolvedValue({
      kind: "ok",
      page: { items: [], nextCursor: null },
    });
    await renderPage();
    expect(screen.getByTestId("stories-empty")).toBeTruthy();
  });

  it("builds a next-page link carrying the cursor and active filters", async () => {
    mockLoad.mockResolvedValue({
      kind: "ok",
      page: {
        items: [
          {
            storyId: "42",
            priorityTier: "HIGH",
            severityScore: 0.7,
            likelihoodScore: 0.6,
            status: "ready",
            recencyTs: new Date("2026-05-27T12:00:00Z"),
          },
        ],
        nextCursor: "CURSOR123",
      },
    });
    await renderPage({ priority: "HIGH", window: "7d" });
    const next = screen.getByTestId("stories-next").getAttribute("href");
    expect(next).toBe(
      `/en/customers/${CUSTOMER_ID}/analysis/story?priority=HIGH&window=7d&cursor=CURSOR123`,
    );
  });

  it("404s when unauthorized and 403s when forbidden", async () => {
    mockLoad.mockResolvedValue({ kind: "unauthorized" });
    await expect(renderPage()).rejects.toThrow("NEXT_NOT_FOUND");
    mockLoad.mockResolvedValue({ kind: "forbidden" });
    await expect(renderPage()).rejects.toThrow("NEXT_FORBIDDEN");
  });
});
