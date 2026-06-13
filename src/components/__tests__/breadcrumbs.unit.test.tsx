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
      suspiciousEvents: "Detections",
      threatStories: "Threat Stories",
      threatStory: "Threat Story",
      event: "Event",
      reports: "Reports",
      settings: "Settings",
      members: "Members",
      customerSettings: "Customer Settings",
      customers: "Customers",
      // `reportPeriod` namespace (the mock ignores the namespace arg).
      LIVE: "Live",
      DAILY: "Daily",
      WEEKLY: "Weekly",
      MONTHLY: "Monthly",
    };
    return map[key] ?? key;
  }),
}));

// The customer name comes from the ambient context (no refetch). Only `c1`
// is known; an unknown id falls back to the raw id.
vi.mock("@/hooks/use-customer-context", () => ({
  useCustomerContext: vi.fn(() => ({
    customers: [{ id: "c1", name: "Acme Corp" }],
  })),
}));

import { usePathname } from "next/navigation";
import {
  BreadcrumbLabelProvider,
  BreadcrumbLabelRegistrar,
} from "../breadcrumb-label-store";
import { Breadcrumbs } from "../breadcrumbs";

const mockedUsePathname = vi.mocked(usePathname);

// Texts of every rendered `<a>` (the mocked `<Link>`), skipping the home
// icon link (which has no text).
function linkTexts(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll("a"))
    .map((a) => a.textContent ?? "")
    .filter((text) => text.length > 0);
}

// Whether any crumb renders `label` as plain text (a non-link span) rather
// than as an `<a>`.
function hasTextCrumb(container: HTMLElement, label: string): boolean {
  const inLink = Array.from(container.querySelectorAll("a")).some(
    (a) => a.textContent === label,
  );
  const inSpan = Array.from(container.querySelectorAll("span")).some(
    (s) => s.children.length === 0 && s.textContent === label,
  );
  return inSpan && !inLink;
}

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
      ["/en/suspicious-events", "Detections"],
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

  it("renders the customer hub trail with a non-link `Customers` prefix", () => {
    // `/customers` has no index page, so the prefix is plain text; the
    // customer name resolves from context and links to the hub.
    mockedUsePathname.mockReturnValue("/en/subjects/c1");

    const { container } = render(<Breadcrumbs />);

    expect(linkTexts(container)).toEqual(["Acme Corp"]);
    expect(hasTextCrumb(container, "Customers")).toBe(true);

    const hub = Array.from(container.querySelectorAll("a")).find(
      (a) => a.textContent === "Acme Corp",
    );
    expect(hub?.getAttribute("href")).toBe("/en/subjects/c1");
  });

  it("falls back to the raw id for an unknown customer", () => {
    mockedUsePathname.mockReturnValue("/en/subjects/unknown");

    const { container } = render(<Breadcrumbs />);

    expect(linkTexts(container)).toEqual(["unknown"]);
  });

  it("renders a deep customer-scoped report path", () => {
    // Home › Customers(text) › Acme Corp › Reports › Daily(text) › date.
    // The customer-scoped `analysis` segment is collapsed (no page).
    mockedUsePathname.mockReturnValue(
      "/en/subjects/c1/analysis/reports/DAILY/2026-06-01",
    );

    const { container } = render(<Breadcrumbs />);

    expect(linkTexts(container)).toEqual([
      "Acme Corp",
      "Reports",
      "2026-06-01",
    ]);

    // Structural prefixes render as plain text, not dead links. The period
    // crumb shows the localized label, not the raw `DAILY` enum.
    expect(hasTextCrumb(container, "Customers")).toBe(true);
    expect(hasTextCrumb(container, "Daily")).toBe(true);
    expect(container.textContent).not.toContain("DAILY");

    // The collapsed `analysis` segment appears nowhere.
    expect(container.textContent).not.toContain("analysis");

    const reports = Array.from(container.querySelectorAll("a")).find(
      (a) => a.textContent === "Reports",
    );
    expect(reports?.getAttribute("href")).toBe(
      "/en/subjects/c1/analysis/reports",
    );
  });

  it("localizes the LIVE report period and bucket crumbs", () => {
    // A LIVE report pins the synthetic epoch bucket `1970-01-01`. The period
    // crumb (text) localizes to "Live", and the leaf bucket crumb (link)
    // stands in with the same localized word instead of the meaningless date
    // or a hardcoded English string.
    mockedUsePathname.mockReturnValue(
      "/en/subjects/c1/analysis/reports/LIVE/1970-01-01",
    );

    const { container } = render(<Breadcrumbs />);

    // The bucket leaf links with the localized "Live" label.
    expect(linkTexts(container)).toEqual(["Acme Corp", "Reports", "Live"]);
    // The period prefix is a single non-link span, also localized.
    const liveSpans = Array.from(container.querySelectorAll("span")).filter(
      (s) => s.children.length === 0 && s.textContent === "Live",
    );
    expect(liveSpans.length).toBe(1);
    // Neither the raw enum nor the synthetic epoch date leaks into the UI.
    expect(container.textContent).not.toContain("LIVE");
    expect(container.textContent).not.toContain("1970");
  });

  it("renders a threat story leaf with a terminology + short-id label", () => {
    mockedUsePathname.mockReturnValue(
      "/en/subjects/c1/analysis/story/s1abcdef0123",
    );

    const { container } = render(<Breadcrumbs />);

    expect(linkTexts(container)).toEqual([
      "Acme Corp",
      "Threat Stories",
      "Threat Story · s1abcdef…",
    ]);
    expect(hasTextCrumb(container, "Customers")).toBe(true);
  });

  it("prefers a page-registered leaf label over the computed fallback", () => {
    // When a leaf page mounts a `<BreadcrumbLabelRegistrar />`, its label
    // (keyed by the leaf path) overrides the terminology + short-id
    // fallback the route map would otherwise compute.
    mockedUsePathname.mockReturnValue(
      "/en/subjects/c1/analysis/story/s1abcdef0123",
    );

    const { container } = render(
      <BreadcrumbLabelProvider>
        <BreadcrumbLabelRegistrar label="Phishing campaign on finance" />
        <Breadcrumbs />
      </BreadcrumbLabelProvider>,
    );

    expect(linkTexts(container)).toEqual([
      "Acme Corp",
      "Threat Stories",
      "Phishing campaign on finance",
    ]);
    // The computed fallback must not also appear.
    expect(container.textContent).not.toContain("Threat Story · s1abcdef…");
  });

  it("renders an event-analysis leaf with the aice prefix collapsed", () => {
    // The `aice/<id>/events/<key>` prefix carries no crumbs; only the event
    // leaf and the customer hub remain. The static client fallback is the bare
    // `Event` term (#559) — never the opaque `event_key`; the page registers
    // the richer `{event time} · {kind}` label once mounted.
    mockedUsePathname.mockReturnValue(
      "/en/subjects/c1/aice/a1/events/evkey123456/analysis",
    );

    const { container } = render(<Breadcrumbs />);

    expect(linkTexts(container)).toEqual(["Acme Corp", "Event"]);
    expect(hasTextCrumb(container, "Customers")).toBe(true);
    expect(container.textContent).not.toContain("aice");
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
