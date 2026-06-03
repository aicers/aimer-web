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
      home: "Home",
      overview: "Overview",
      suspiciousEvents: "Suspicious Events",
      threatStories: "Threat Stories",
      reports: "Reports",
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

  it("labels the home icon link with an accessible name", () => {
    mockedUsePathname.mockReturnValue("/en");

    const { container } = render(<Breadcrumbs />);

    const home = container.querySelector("a");
    expect(home?.getAttribute("aria-label")).toBe("Home");
  });

  it("renders crumbs for /en/overview", () => {
    mockedUsePathname.mockReturnValue("/en/overview");

    const { container } = render(<Breadcrumbs />);

    const links = container.querySelectorAll("a");
    expect(links.length).toBe(2);
    expect(links[0].getAttribute("href")).toBe("/en");
    expect(links[1].getAttribute("href")).toBe("/en/overview");
    expect(links[1].textContent).toBe("Overview");
  });

  it("renders crumbs for the new top-level cross-customer routes", () => {
    const routes: Array<[string, string]> = [
      ["/en/suspicious-events", "Suspicious Events"],
      ["/en/threat-stories", "Threat Stories"],
    ];

    for (const [path, label] of routes) {
      mockedUsePathname.mockReturnValue(path);
      const { container, unmount } = render(<Breadcrumbs />);

      const links = container.querySelectorAll("a");
      expect(links.length).toBe(2);
      expect(links[1].getAttribute("href")).toBe(path);
      expect(links[1].textContent).toBe(label);

      unmount();
    }
  });

  it("labels deep events/story segments with the plural parent labels", () => {
    // The deep route identifiers stay `events`/`story`, but the crumbs read
    // "Suspicious Events"/"Threat Stories" (parent route policy, #394). The
    // `customers/<id>` segments are unknown and skipped; `analysis` is
    // intentionally dropped (no page there).
    mockedUsePathname.mockReturnValue("/en/customers/c1/analysis/events");
    {
      const { container, unmount } = render(<Breadcrumbs />);
      const links = container.querySelectorAll("a");
      expect(links.length).toBe(2);
      expect(links[1].getAttribute("href")).toBe(
        "/en/customers/c1/analysis/events",
      );
      expect(links[1].textContent).toBe("Suspicious Events");
      unmount();
    }

    mockedUsePathname.mockReturnValue("/en/customers/c1/analysis/story");
    {
      const { container, unmount } = render(<Breadcrumbs />);
      const links = container.querySelectorAll("a");
      expect(links.length).toBe(2);
      expect(links[1].getAttribute("href")).toBe(
        "/en/customers/c1/analysis/story",
      );
      expect(links[1].textContent).toBe("Threat Stories");
      unmount();
    }
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

  it("renders a crumb for /en/reports", () => {
    mockedUsePathname.mockReturnValue("/en/reports");
    const { container } = render(<Breadcrumbs />);

    const links = container.querySelectorAll("a");
    expect(links.length).toBe(2);
    expect(links[1].textContent).toBe("Reports");
  });

  it("renders no crumb for dropped legacy stub segments", () => {
    // `/analysis` and `/dashboard` are redirect stubs with no rendered page
    // and no breadcrumb mapping; only the home link remains.
    for (const path of ["/en/analysis", "/en/dashboard"]) {
      mockedUsePathname.mockReturnValue(path);
      const { container, unmount } = render(<Breadcrumbs />);

      const links = container.querySelectorAll("a");
      expect(links.length).toBe(1);

      unmount();
    }
  });
});
