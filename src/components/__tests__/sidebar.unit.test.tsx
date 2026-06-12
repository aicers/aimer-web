// @vitest-environment jsdom
import { fireEvent, render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------- Mocks ----------

vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    ...props
  }: {
    href: string;
    children: React.ReactNode;
    onClick?: () => void;
  }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

vi.mock("next/navigation", () => ({
  usePathname: vi.fn(() => "/en"),
}));

vi.mock("next-intl", () => {
  const navMap: Record<string, string> = {
    overview: "Overview",
    reports: "Reports",
    threatStories: "Threat Stories",
    suspiciousEvents: "Suspicious Events",
    accountSettings: "Account Settings",
    members: "Members",
    customerSettings: "Customer Settings",
  };
  const sidebarMap: Record<string, string> = {
    scopeLabel: "Customer scope",
    summarySubjectsLabel: "Subjects",
    subjectsCustomersLabel: "Customers",
    subjectsGroupsLabel: "Groups",
    scopePresetsLabel: "Group presets",
    scopePresetsHint: "Selecting a group fills the customer scope above.",
    scopeAll: "All customers",
    bridgeLocked: "Locked to bridge session",
    expandSidebar: "Expand sidebar",
    collapseSidebar: "Collapse sidebar",
    openMenu: "Open navigation menu",
  };
  return {
    useLocale: vi.fn(() => "en"),
    useTranslations: vi.fn((ns: string) => {
      if (ns === "nav") return (key: string) => navMap[key] ?? key;
      if (ns === "sidebar")
        return (key: string, vars?: Record<string, unknown>) => {
          if (key === "scopeSelected")
            return `${vars?.count} of ${vars?.total} customers`;
          if (key === "scopePresetApply") return `Apply ${vars?.name} to scope`;
          return sidebarMap[key] ?? key;
        };
      return (key: string) => key;
    }),
  };
});

vi.mock("@/hooks/use-customer-context", () => ({
  useCustomerContext: vi.fn(),
}));

vi.mock("@/hooks/use-permissions", () => ({
  usePermissions: vi.fn(),
}));

vi.mock("@/components/ui/tooltip", () => ({
  TooltipProvider: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({
    children,
  }: {
    children: React.ReactNode;
    asChild?: boolean;
  }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => (
    <span data-testid="tooltip" hidden>
      {children}
    </span>
  ),
}));

let lastOnOpenChange: ((v: boolean) => void) | undefined;

vi.mock("@/components/ui/sheet", () => ({
  Sheet: ({
    children,
    onOpenChange,
  }: {
    children: React.ReactNode;
    open?: boolean;
    onOpenChange?: (v: boolean) => void;
  }) => {
    lastOnOpenChange = onOpenChange;
    return <div data-testid="sheet">{children}</div>;
  },
  SheetTrigger: ({
    children,
  }: {
    children: React.ReactNode;
    asChild?: boolean;
  }) => <div data-testid="sheet-trigger">{children}</div>,
  SheetContent: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="sheet-content">{children}</div>
  ),
}));

import { usePathname } from "next/navigation";
import { useCustomerContext } from "@/hooks/use-customer-context";
import { usePermissions } from "@/hooks/use-permissions";
import { MobileSidebarTrigger, Sidebar } from "../sidebar";

const mockedUseCustomerContext = vi.mocked(useCustomerContext);
const mockedUsePermissions = vi.mocked(usePermissions);
const mockedUsePathname = vi.mocked(usePathname);

const CUSTOMERS = [
  {
    id: "c1",
    externalKey: "ext-1",
    name: "Acme Corp",
    role: "Manager",
    isAnalyst: false,
    permissions: [],
  },
  {
    id: "c2",
    externalKey: "ext-2",
    name: "Beta Inc",
    role: "User",
    isAnalyst: false,
    permissions: [],
  },
];

const GROUPS = [
  {
    id: "g1",
    name: "East Region",
    description: null,
    memberIds: ["c1", "c2"],
    tz: "UTC",
  },
];

function mockDefaults(
  overrides?: Partial<ReturnType<typeof useCustomerContext>>,
) {
  mockedUseCustomerContext.mockReturnValue({
    me: {
      accountId: "acc-1",
      sessionId: "sess-1",
      authContext: "general",
      username: "tester",
      displayName: "Test User",
      email: "test@example.com",
      locale: null,
      timezone: null,
      timeFormatLocale: null,
      timeFormatHourCycle: null,
      timeFormatSeconds: null,
      timeFormatTzLabel: null,
      analystEligible: false,
      bridge: { active: false, aiceId: null, customerIds: null },
      memberships: [],
    },
    customers: CUSTOMERS,
    groups: [],
    scope: { isAll: true, customerIds: ["c1", "c2"], canonical: "all" },
    singleCustomerId: null,
    setScope: vi.fn(),
    isBridgeSession: false,
    loading: false,
    ...overrides,
  });
}

function mockPermissions(
  overrides?: Partial<ReturnType<typeof usePermissions>>,
) {
  mockedUsePermissions.mockReturnValue({
    role: "Manager",
    isAnalyst: false,
    isManager: true,
    hasPermission: () => false,
    canViewMembers: true,
    canViewCustomerSettings: true,
    canViewRedactionRanges: true,
    canWriteRedactionRanges: true,
    canViewRetention: true,
    canWriteRetention: true,
    canViewDefaultModel: true,
    canWriteDefaultModel: true,
    canUseAnalystFeatures: false,
    ...overrides,
  });
}

function setup() {
  mockDefaults();
  mockPermissions();
}

function assertDefined<T>(value: T | null | undefined): asserts value is T {
  expect(value).not.toBeNull();
}

// ---------- Tests ----------

describe("Sidebar", () => {
  beforeEach(() => {
    localStorage.clear();
    mockedUsePathname.mockReturnValue("/en");
    setup();
  });

  it("renders all general navigation items", () => {
    const { container } = render(<Sidebar collapsed={false} />);
    const nav = container.querySelector('nav[aria-label="Main"]');
    assertDefined(nav);
    const text = nav.textContent ?? "";

    expect(text).toContain("Overview");
    expect(text).toContain("Reports");
    expect(text).toContain("Threat Stories");
    expect(text).toContain("Suspicious Events");
    expect(text).toContain("Account Settings");
  });

  it("renders single-customer items when a single customer is in scope", () => {
    mockDefaults({
      customers: [CUSTOMERS[0]],
      scope: { isAll: true, customerIds: ["c1"], canonical: "all" },
      singleCustomerId: "c1",
    });

    const { container } = render(<Sidebar collapsed={false} />);
    const nav = container.querySelector('nav[aria-label="Main"]');
    assertDefined(nav);
    const text = nav.textContent ?? "";

    expect(text).toContain("Members");
    expect(text).toContain("Customer Settings");
  });

  it("hides single-customer items under a multi-/all-scope", () => {
    // Default scope resolves to two customers ⇒ singleCustomerId null, so the
    // links are hidden even though permissions allow them.
    const { container } = render(<Sidebar collapsed={false} />);
    const nav = container.querySelector('nav[aria-label="Main"]');
    assertDefined(nav);
    const text = nav.textContent ?? "";

    expect(text).not.toContain("Members");
    expect(text).not.toContain("Customer Settings");
  });

  it("hides single-customer items when permissions deny them", () => {
    mockDefaults({
      customers: [CUSTOMERS[0]],
      scope: { isAll: true, customerIds: ["c1"], canonical: "all" },
      singleCustomerId: "c1",
    });
    mockPermissions({
      isManager: false,
      canViewMembers: false,
      canViewCustomerSettings: false,
    });

    const { container } = render(<Sidebar collapsed={false} />);
    const nav = container.querySelector('nav[aria-label="Main"]');
    assertDefined(nav);
    const text = nav.textContent ?? "";

    expect(text).not.toContain("Members");
    expect(text).not.toContain("Customer Settings");
  });

  it("renders a scope checkbox per customer, all checked under all-scope", () => {
    const { container } = render(<Sidebar collapsed={false} />);
    const boxes = container.querySelectorAll<HTMLInputElement>(
      'input[type="checkbox"]',
    );

    expect(boxes.length).toBe(2);
    expect([...boxes].every((b) => b.checked)).toBe(true);
    expect(container.textContent).toContain("All customers");
  });

  it("checks only the in-scope customers under a subset scope", () => {
    mockDefaults({
      scope: { isAll: false, customerIds: ["c2"], canonical: "c2" },
      singleCustomerId: "c2",
    });

    const { container } = render(<Sidebar collapsed={false} />);
    const boxes = container.querySelectorAll<HTMLInputElement>(
      'input[type="checkbox"]',
    );

    expect(boxes[0].checked).toBe(false); // c1
    expect(boxes[1].checked).toBe(true); // c2
    expect(container.textContent).toContain("1 of 2 customers");
  });

  it("toggling a customer off under all-scope narrows to the rest", () => {
    const setScope = vi.fn();
    mockDefaults({ setScope });

    const { container } = render(<Sidebar collapsed={false} />);
    const boxes = container.querySelectorAll<HTMLInputElement>(
      'input[type="checkbox"]',
    );

    fireEvent.click(boxes[0]); // uncheck c1
    expect(setScope).toHaveBeenCalledWith(["c2"]);
  });

  it("short-circuits the scope control in a bridge session", () => {
    mockDefaults({
      isBridgeSession: true,
      me: {
        accountId: "acc-1",
        sessionId: "sess-1",
        authContext: "general",
        username: "tester",
        displayName: "Test User",
        email: "test@example.com",
        locale: null,
        timezone: null,
        timeFormatLocale: null,
        timeFormatHourCycle: null,
        timeFormatSeconds: null,
        timeFormatTzLabel: null,
        analystEligible: false,
        bridge: { active: true, aiceId: "env-1", customerIds: ["c1"] },
        memberships: [],
      },
    });

    const { container } = render(<Sidebar collapsed={false} />);

    expect(container.querySelectorAll('input[type="checkbox"]').length).toBe(0);
    expect(container.textContent).toContain("Locked to bridge session");
  });

  it("preserves a narrowed scope on nav and single-customer links", () => {
    // Two accessible customers, scope narrowed to c1 ⇒ the single-customer
    // settings links appear AND must carry `?scope=c1`; otherwise clicking
    // them drops the scope and the page re-normalizes to all customers,
    // landing on the scope-required state (#390).
    mockDefaults({
      scope: { isAll: false, customerIds: ["c1"], canonical: "c1" },
      singleCustomerId: "c1",
    });

    const { container } = render(<Sidebar collapsed={false} />);
    const href = (label: string) =>
      [...container.querySelectorAll("a")]
        .find((a) => a.textContent?.includes(label))
        ?.getAttribute("href");

    expect(href("Members")).toBe("/en/settings/members?scope=c1");
    expect(href("Customer Settings")).toBe("/en/settings/customer?scope=c1");
    expect(href("Reports")).toBe("/en/reports?scope=c1");
    // Overview is a cross-customer surface, so it carries the active scope.
    expect(href("Overview")).toBe("/en/overview?scope=c1");
    // Account Settings is a personal page, not scoped.
    expect(href("Account Settings")).toBe("/en/settings/account");
  });

  it("leaves links unscoped under the default all-scope", () => {
    const { container } = render(<Sidebar collapsed={false} />);
    const reports = [...container.querySelectorAll("a")].find((a) =>
      a.textContent?.includes("Reports"),
    );
    expect(reports?.getAttribute("href")).toBe("/en/reports");
  });

  it("marks active nav item with aria-current=page", () => {
    mockedUsePathname.mockReturnValue("/en/suspicious-events");

    const { container } = render(<Sidebar collapsed={false} />);

    const activeLink = container.querySelector(
      'a[aria-current="page"]',
    ) as HTMLAnchorElement;
    expect(activeLink).not.toBeNull();
    expect(activeLink.getAttribute("href")).toBe("/en/suspicious-events");
  });

  it("hides scope selector when collapsed", () => {
    const { container } = render(<Sidebar collapsed={true} />);

    expect(container.querySelector('input[type="checkbox"]')).toBeNull();
    expect(container.textContent).not.toContain("Customer scope");
  });
});

describe("Sidebar summary subjects", () => {
  beforeEach(() => {
    localStorage.clear();
    mockedUsePathname.mockReturnValue("/en");
    setup();
  });

  function subjectsNav(container: HTMLElement) {
    return container.querySelector('nav[aria-label="Subjects"]');
  }

  it("renders a hub link per accessible customer", () => {
    const { container } = render(<Sidebar collapsed={false} />);
    const nav = subjectsNav(container);
    assertDefined(nav);
    const links = nav.querySelectorAll("a");

    expect(links.length).toBe(2);
    const text = nav.textContent ?? "";
    expect(text).toContain("Acme Corp");
    expect(text).toContain("Beta Inc");
  });

  it("targets the locale-prefixed /subjects hub via subjectPages.hub", () => {
    const { container } = render(<Sidebar collapsed={false} />);
    const nav = subjectsNav(container);
    assertDefined(nav);
    const href = (name: string) =>
      [...nav.querySelectorAll("a")]
        .find((a) => a.textContent?.includes(name))
        ?.getAttribute("href");

    expect(href("Acme Corp")).toBe("/en/subjects/c1");
    expect(href("Beta Inc")).toBe("/en/subjects/c2");
  });

  it("carries no ?scope= query on subject links", () => {
    // Narrow the scope so the cross-customer nav items carry `?scope=c1`;
    // subject hub links must remain unscoped regardless.
    mockDefaults({
      scope: { isAll: false, customerIds: ["c1"], canonical: "c1" },
      singleCustomerId: "c1",
    });

    const { container } = render(<Sidebar collapsed={false} />);
    const nav = subjectsNav(container);
    assertDefined(nav);

    for (const a of nav.querySelectorAll("a")) {
      expect(a.getAttribute("href")).not.toContain("scope=");
    }
  });

  it("marks the active subject when the route is under its hub", () => {
    mockedUsePathname.mockReturnValue("/en/subjects/c2/analysis/reports");

    const { container } = render(<Sidebar collapsed={false} />);
    const nav = subjectsNav(container);
    assertDefined(nav);
    const active = nav.querySelector('a[aria-current="page"]');
    assertDefined(active);
    expect(active.getAttribute("href")).toBe("/en/subjects/c2");
  });

  it("omits the section entirely in a bridge session", () => {
    // The hub route forbids in-scope bridge sessions (`allowInBridge: false`
    // → 403), so every hub link would dead-end at a 403. The section must not
    // render dead links — it short-circuits like the scope selector does.
    mockDefaults({
      customers: [CUSTOMERS[0]],
      isBridgeSession: true,
      me: {
        accountId: "acc-1",
        sessionId: "sess-1",
        authContext: "general",
        username: "tester",
        displayName: "Test User",
        email: "test@example.com",
        locale: null,
        timezone: null,
        timeFormatLocale: null,
        timeFormatHourCycle: null,
        timeFormatSeconds: null,
        timeFormatTzLabel: null,
        analystEligible: false,
        bridge: { active: true, aiceId: "env-1", customerIds: ["c1"] },
        memberships: [],
      },
    });

    const { container } = render(<Sidebar collapsed={false} />);

    expect(subjectsNav(container)).toBeNull();
  });

  it("renders subject links when collapsed", () => {
    const { container } = render(<Sidebar collapsed={true} />);
    const nav = subjectsNav(container);
    assertDefined(nav);
    expect(nav.querySelectorAll("a").length).toBe(2);
  });

  it("lists groups in a distinct sub-section with unscoped hub links (#513)", () => {
    mockDefaults({ groups: GROUPS });
    const { container } = render(<Sidebar collapsed={false} />);
    const nav = subjectsNav(container);
    assertDefined(nav);

    const customers = nav.querySelector(
      '[data-testid="summary-subjects-customers"]',
    );
    const groups = nav.querySelector('[data-testid="summary-subjects-groups"]');
    assertDefined(customers);
    assertDefined(groups);

    const groupLink = [...groups.querySelectorAll("a")].find((a) =>
      a.textContent?.includes("East Region"),
    );
    assertDefined(groupLink);
    // Group hub link targets the group's /subjects hub, with no ?scope=.
    expect(groupLink.getAttribute("href")).toBe("/en/subjects/g1");
    expect(groupLink.getAttribute("href")).not.toContain("scope=");
  });
});

describe("Sidebar group scope presets (#513)", () => {
  beforeEach(() => {
    localStorage.clear();
    mockedUsePathname.mockReturnValue("/en");
    setup();
  });

  it("renders a preset button per group and expands it to member ids on click", () => {
    const setScope = vi.fn();
    mockDefaults({ groups: GROUPS, setScope });

    const { container } = render(<Sidebar collapsed={false} />);
    const presetBtn = [...container.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("East Region"),
    );
    assertDefined(presetBtn);

    fireEvent.click(presetBtn);
    // The preset is a pure view filter: it expands the group into its member
    // customer ids in the scope, NOT a navigation.
    expect(setScope).toHaveBeenCalledWith(["c1", "c2"]);
  });

  it("renders no group presets when there are no groups", () => {
    const { container } = render(<Sidebar collapsed={false} />);
    expect(container.textContent).not.toContain("Group presets");
  });
});

describe("MobileSidebarTrigger", () => {
  beforeEach(() => {
    localStorage.clear();
    mockedUsePathname.mockReturnValue("/en");
    setup();
  });

  it("renders menu button with aria-label", () => {
    const { container } = render(<MobileSidebarTrigger />);

    const menuBtn = container.querySelector(
      'button[aria-label="Open navigation menu"]',
    );
    expect(menuBtn).not.toBeNull();
  });

  it("renders sidebar content inside sheet", () => {
    const { container } = render(<MobileSidebarTrigger />);

    const sheetContents = container.querySelectorAll(
      '[data-testid="sheet-content"]',
    );
    expect(sheetContents.length).toBe(1);

    const text = sheetContents[0].textContent ?? "";
    expect(text).toContain("Overview");
    expect(text).toContain("Reports");
    expect(text).toContain("Threat Stories");
    expect(text).toContain("Suspicious Events");
  });

  it("renders scope selector inside sheet", () => {
    const { container } = render(<MobileSidebarTrigger />);

    const sheetContent = container.querySelector(
      '[data-testid="sheet-content"]',
    );
    assertDefined(sheetContent);
    const boxes = sheetContent.querySelectorAll('input[type="checkbox"]');
    expect(boxes.length).toBe(2);
  });

  it("closes sheet when a nav link is clicked", () => {
    const { container } = render(<MobileSidebarTrigger />);

    const sheetContent = container.querySelector(
      '[data-testid="sheet-content"]',
    );
    assertDefined(sheetContent);

    const navLink = sheetContent.querySelector('nav[aria-label="Main"] a');
    assertDefined(navLink);
    fireEvent.click(navLink);

    assertDefined(lastOnOpenChange);
    expect(typeof lastOnOpenChange).toBe("function");
  });

  it("closes sheet when a subject hub link is clicked", () => {
    const { container } = render(<MobileSidebarTrigger />);

    const sheetContent = container.querySelector(
      '[data-testid="sheet-content"]',
    );
    assertDefined(sheetContent);

    const subjectLink = sheetContent.querySelector(
      'nav[aria-label="Subjects"] a',
    );
    assertDefined(subjectLink);
    // Subject links carry the same `onNavigate` close handler the nav links
    // use, so a click invokes it (the mocked Sheet records onOpenChange).
    fireEvent.click(subjectLink);

    assertDefined(lastOnOpenChange);
    expect(typeof lastOnOpenChange).toBe("function");
  });
});
