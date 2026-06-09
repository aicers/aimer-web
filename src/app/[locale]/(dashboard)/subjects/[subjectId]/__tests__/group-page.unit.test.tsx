// @vitest-environment jsdom
//
// RFC 0004 #513 (C2) — group analysis hub. Verifies the subject-kind dispatch
// renders the GROUP hub (reports-only card, no story/event cards) and maps the
// group loader's denials to notFound/forbidden.

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GroupHubPageOutcome } from "@/lib/analysis/group-hub-page-loader";

const mockGroupLoad = vi.fn<() => Promise<GroupHubPageOutcome>>();

vi.mock("@/lib/analysis/group-hub-page-loader", () => ({
  loadGroupHubPage: () => mockGroupLoad(),
}));
// Customer loader is imported by the page but unused on the group branch; stub
// it so importing the page in jsdom does not pull `server-only`.
vi.mock("@/lib/analysis/customer-hub-page-loader", () => ({
  loadCustomerHubPage: async () => ({ kind: "unauthorized" }),
}));
vi.mock("@/lib/db/client", () => ({ getAuthPool: () => ({}) }));
vi.mock("@/lib/db/subject-runtime-pool", () => ({
  getSubjectKind: async () => "group",
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

import SubjectHubPage from "../page";

const GROUP_ID = "11111111-1111-1111-1111-111111111111";

async function renderPage(): Promise<void> {
  const jsx = await SubjectHubPage({
    params: Promise.resolve({ locale: "en", subjectId: GROUP_ID }),
  });
  render(jsx);
}

describe("group hub page", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => cleanup());

  it("renders only the reports card — no story/event cards", async () => {
    mockGroupLoad.mockResolvedValue({
      kind: "ok",
      sections: { reports: true },
    });
    await renderPage();
    expect(screen.getByTestId("hub-link-reports").getAttribute("href")).toBe(
      `/en/subjects/${GROUP_ID}/analysis/reports`,
    );
    expect(screen.queryByTestId("hub-link-stories")).toBeNull();
    expect(screen.queryByTestId("hub-link-events")).toBeNull();
  });

  it("404s when the group loader reports unauthorized", async () => {
    mockGroupLoad.mockResolvedValue({ kind: "unauthorized" });
    await expect(renderPage()).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("403s when the group loader reports forbidden", async () => {
    mockGroupLoad.mockResolvedValue({ kind: "forbidden" });
    await expect(renderPage()).rejects.toThrow("NEXT_FORBIDDEN");
  });
});
