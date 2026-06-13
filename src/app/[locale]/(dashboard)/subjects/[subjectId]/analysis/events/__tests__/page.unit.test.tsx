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

// `<Timestamp>` (the row title since #552) reads the active locale via
// `useLocale()`; this page test renders it outside a `NextIntlClientProvider`,
// so supply a fixed locale while keeping the rest of next-intl real.
vi.mock("next-intl", async () => {
  const actual = await vi.importActual<typeof import("next-intl")>("next-intl");
  return { ...actual, useLocale: () => "en" };
});

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
          eventTime: new Date("2026-05-20T00:00:00Z"),
          kind: "HttpThreat",
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
    params: Promise.resolve({ locale: "en", subjectId: CUSTOMER_ID }),
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

  it("links rows to the event detail page with the viewer-locale lang + canonical model params (#581)", async () => {
    await renderPage();
    const href = screen
      .getByTestId("event-link-aice-1-123456789")
      .getAttribute("href");
    // `?lang` is the viewer's locale (`en`), cross-compatible with report /
    // story links; the model params still pin the canonical variant.
    expect(href).toBe(
      `/en/subjects/${CUSTOMER_ID}/aice/aice-1/events/123456789/analysis?lang=en&model_name=openai&model=gpt-4o`,
    );
  });

  it("titles the row by kind display name, never the raw event_key (#552)", async () => {
    await renderPage();
    const link = screen.getByTestId("event-link-aice-1-123456789");
    // Friendly kind name from the ported map (`HttpThreat` → "HTTP Threat").
    expect(link.textContent).toContain("HTTP Threat");
    // The raw event_key never titles the row (it remains only in the link).
    expect(link.querySelector(".font-medium")?.textContent).not.toContain(
      "123456789",
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
      `/en/subjects/${CUSTOMER_ID}/analysis/events?priority=CRITICAL&window=24h&cursor=CURSOR123`,
    );
  });

  it("404s when unauthorized and 403s when forbidden", async () => {
    mockLoad.mockResolvedValue({ kind: "unauthorized" });
    await expect(renderPage()).rejects.toThrow("NEXT_NOT_FOUND");
    mockLoad.mockResolvedValue({ kind: "forbidden" });
    await expect(renderPage()).rejects.toThrow("NEXT_FORBIDDEN");
  });
});
