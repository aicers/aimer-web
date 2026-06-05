// @vitest-environment jsdom
//
// WS3 (#392) — Suspicious Events list page. Verifies:
//   - rows link to the event detail page WITH the canonical variant params
//     (lang/model_name/model) so the detail page resolves instead of 404ing
//   - the empty banner shows when no events match
//   - the next-page link carries the cursor + active filters
//   - unauthorized → notFound (404); forbidden → forbidden (403)

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EventListPageOutcome } from "@/lib/analysis/event-list-page-loader";

const mockLoad = vi.fn<() => Promise<EventListPageOutcome>>();

vi.mock("@/lib/analysis/event-list-page-loader", () => ({
  loadEventListPage: () => mockLoad(),
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

import SuspiciousEventListPage from "../page";

const CUSTOMER_ID = "c0000000-0000-0000-0000-000000000001";

function okPage(nextCursor: string | null) {
  return {
    kind: "ok" as const,
    page: {
      items: [
        {
          aiceId: "aice-1",
          eventKey: "123456789",
          priorityTier: "CRITICAL" as const,
          severityScore: 0.9,
          likelihoodScore: 0.8,
          requestedAt: new Date("2026-05-27T12:00:00Z"),
        },
      ],
      nextCursor,
      variant: { lang: "ENGLISH", modelName: "openai", model: "gpt-4o" },
    },
  };
}

async function renderPage(
  searchParams: Record<string, string> = {},
): Promise<void> {
  const jsx = await SuspiciousEventListPage({
    params: Promise.resolve({ locale: "en", customerId: CUSTOMER_ID }),
    searchParams: Promise.resolve(searchParams),
  });
  render(jsx);
}

describe("suspicious events list page", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLoad.mockResolvedValue(okPage(null));
  });
  afterEach(() => cleanup());

  it("links rows to the event detail page with the canonical variant params", async () => {
    await renderPage();
    const href = screen
      .getByTestId("event-link-aice-1-123456789")
      .getAttribute("href");
    expect(href).toBe(
      `/en/customers/${CUSTOMER_ID}/aice/aice-1/events/123456789/analysis?lang=ENGLISH&model_name=openai&model=gpt-4o`,
    );
  });

  it("renders the empty banner when no events match", async () => {
    mockLoad.mockResolvedValue({
      kind: "ok",
      page: {
        items: [],
        nextCursor: null,
        variant: { lang: "ENGLISH", modelName: "openai", model: "gpt-4o" },
      },
    });
    await renderPage();
    expect(screen.getByTestId("events-empty")).toBeTruthy();
  });

  it("builds a next-page link carrying the cursor and active filters", async () => {
    mockLoad.mockResolvedValue(okPage("CURSOR123"));
    await renderPage({ priority: "CRITICAL", window: "24h" });
    expect(screen.getByTestId("events-next").getAttribute("href")).toBe(
      `/en/customers/${CUSTOMER_ID}/analysis/events?priority=CRITICAL&window=24h&cursor=CURSOR123`,
    );
  });

  it("404s when unauthorized and 403s when forbidden", async () => {
    mockLoad.mockResolvedValue({ kind: "unauthorized" });
    await expect(renderPage()).rejects.toThrow("NEXT_NOT_FOUND");
    mockLoad.mockResolvedValue({ kind: "forbidden" });
    await expect(renderPage()).rejects.toThrow("NEXT_FORBIDDEN");
  });
});
