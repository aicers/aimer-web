// @vitest-environment jsdom
import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

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

vi.mock("next/navigation", () => ({
  usePathname: vi.fn(),
}));

vi.mock("next-intl", () => ({
  useLocale: vi.fn(() => "en"),
  useTranslations: vi.fn(() => (key: string) => {
    const map: Record<string, string> = {
      events: "Events",
      analysis: "Analysis",
      reports: "Reports",
      dashboard: "Dashboard",
      settings: "Settings",
      members: "Members",
      customerSettings: "Customer Settings",
    };
    return map[key] ?? key;
  }),
}));

import { usePathname } from "next/navigation";
import { Breadcrumbs } from "../breadcrumbs";

const mockedUsePathname = vi.mocked(usePathname);

describe("Breadcrumbs", () => {
  it("renders only home link on the home page", () => {
    mockedUsePathname.mockReturnValue("/en");

    const { container } = render(<Breadcrumbs />);

    const links = container.querySelectorAll("a");
    expect(links.length).toBe(1);
    expect(links[0].getAttribute("href")).toBe("/en");
  });

  it("renders crumbs for /en/events", () => {
    mockedUsePathname.mockReturnValue("/en/events");

    const { container } = render(<Breadcrumbs />);

    const links = container.querySelectorAll("a");
    expect(links.length).toBe(2);
    expect(links[0].getAttribute("href")).toBe("/en");
    expect(links[1].getAttribute("href")).toBe("/en/events");
    expect(links[1].textContent).toBe("Events");
  });

  it("renders nested crumbs for /en/settings/members", () => {
    mockedUsePathname.mockReturnValue("/en/settings/members");

    const { container } = render(<Breadcrumbs />);

    const links = container.querySelectorAll("a");
    expect(links.length).toBe(3);
    expect(links[1].getAttribute("href")).toBe("/en/settings");
    expect(links[1].textContent).toBe("Settings");
    expect(links[2].getAttribute("href")).toBe("/en/settings/members");
    expect(links[2].textContent).toBe("Members");
  });

  it("skips unknown segments", () => {
    mockedUsePathname.mockReturnValue("/en/unknown/path");

    const { container } = render(<Breadcrumbs />);

    const links = container.querySelectorAll("a");
    // Only home link
    expect(links.length).toBe(1);
  });

  it("has breadcrumb aria-label on nav element", () => {
    mockedUsePathname.mockReturnValue("/en");

    const { container } = render(<Breadcrumbs />);

    const nav = container.querySelector('nav[aria-label="Breadcrumb"]');
    expect(nav).not.toBeNull();
  });

  it("renders customer settings crumb for /en/settings/customer", () => {
    mockedUsePathname.mockReturnValue("/en/settings/customer");

    const { container } = render(<Breadcrumbs />);

    const links = container.querySelectorAll("a");
    expect(links.length).toBe(3);
    expect(links[2].textContent).toBe("Customer Settings");
  });

  it("renders only known segments in a deep path with unknown parts", () => {
    mockedUsePathname.mockReturnValue("/en/settings/members/some-id");

    const { container } = render(<Breadcrumbs />);

    const links = container.querySelectorAll("a");
    // Home + Settings + Members (some-id is unknown and skipped)
    expect(links.length).toBe(3);
    expect(links[1].textContent).toBe("Settings");
    expect(links[2].textContent).toBe("Members");
  });

  it("renders crumbs for each page route", () => {
    const routes: Array<[string, string]> = [
      ["/en/analysis", "Analysis"],
      ["/en/reports", "Reports"],
      ["/en/dashboard", "Dashboard"],
    ];

    for (const [path, label] of routes) {
      mockedUsePathname.mockReturnValue(path);
      const { container, unmount } = render(<Breadcrumbs />);

      const links = container.querySelectorAll("a");
      expect(links.length).toBe(2);
      expect(links[1].textContent).toBe(label);

      unmount();
    }
  });
});
