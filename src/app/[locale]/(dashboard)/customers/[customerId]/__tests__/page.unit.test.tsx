// @vitest-environment jsdom
//
// WS3 (#392) — customer hub page. Verifies:
//   - permitted sections render as links; non-permitted are hidden
//   - a member with no sections sees the empty banner (not a 404)
//   - unauthorized → notFound (404); forbidden → forbidden (403)

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CustomerHubPageOutcome } from "@/lib/analysis/customer-hub-page-loader";

const mockLoad = vi.fn<() => Promise<CustomerHubPageOutcome>>();

vi.mock("@/lib/analysis/customer-hub-page-loader", () => ({
  loadCustomerHubPage: () => mockLoad(),
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

import CustomerHubPage from "../page";

const CUSTOMER_ID = "c0000000-0000-0000-0000-000000000001";

async function renderPage(): Promise<void> {
  const jsx = await CustomerHubPage({
    params: Promise.resolve({ locale: "en", customerId: CUSTOMER_ID }),
  });
  render(jsx);
}

describe("customer hub page", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => cleanup());

  it("renders all three section links when all permissions are present", async () => {
    mockLoad.mockResolvedValue({
      kind: "ok",
      sections: { reports: true, threatStories: true, suspiciousEvents: true },
    });
    await renderPage();
    expect(screen.getByTestId("hub-link-reports").getAttribute("href")).toBe(
      `/en/customers/${CUSTOMER_ID}/analysis/reports`,
    );
    expect(screen.getByTestId("hub-link-stories").getAttribute("href")).toBe(
      `/en/customers/${CUSTOMER_ID}/analysis/story`,
    );
    expect(screen.getByTestId("hub-link-events").getAttribute("href")).toBe(
      `/en/customers/${CUSTOMER_ID}/analysis/events`,
    );
  });

  it("hides sections the member lacks permission for", async () => {
    mockLoad.mockResolvedValue({
      kind: "ok",
      sections: {
        reports: true,
        threatStories: false,
        suspiciousEvents: false,
      },
    });
    await renderPage();
    expect(screen.getByTestId("hub-link-reports")).toBeTruthy();
    expect(screen.queryByTestId("hub-link-stories")).toBeNull();
    expect(screen.queryByTestId("hub-link-events")).toBeNull();
  });

  it("shows the empty banner for a member with no permitted sections", async () => {
    mockLoad.mockResolvedValue({
      kind: "ok",
      sections: {
        reports: false,
        threatStories: false,
        suspiciousEvents: false,
      },
    });
    await renderPage();
    expect(screen.getByTestId("hub-empty")).toBeTruthy();
    expect(screen.queryByTestId("hub")).toBeNull();
  });

  it("404s when the loader reports unauthorized (non-member)", async () => {
    mockLoad.mockResolvedValue({ kind: "unauthorized" });
    await expect(renderPage()).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("403s when the loader reports forbidden (bridge)", async () => {
    mockLoad.mockResolvedValue({ kind: "forbidden" });
    await expect(renderPage()).rejects.toThrow("NEXT_FORBIDDEN");
  });
});
