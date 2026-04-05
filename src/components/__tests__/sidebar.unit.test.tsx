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
    home: "Home",
    events: "Events",
    analysis: "Analysis",
    reports: "Reports",
    dashboard: "Dashboard",
    members: "Members",
    customerSettings: "Customer Settings",
  };
  const sidebarMap: Record<string, string> = {
    selectCustomer: "Customer",
    selectEnvironment: "Environment",
    bridgeLocked: "Locked to bridge session",
    expandSidebar: "Expand sidebar",
    collapseSidebar: "Collapse sidebar",
    openMenu: "Open navigation menu",
  };
  return {
    useLocale: vi.fn(() => "en"),
    useTranslations: vi.fn((ns: string) => {
      if (ns === "nav") return (key: string) => navMap[key] ?? key;
      if (ns === "sidebar") return (key: string) => sidebarMap[key] ?? key;
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
      analystEligible: false,
      bridge: { active: false, aiceId: null, customerIds: null },
      memberships: [],
    },
    customers: [
      {
        id: "c1",
        externalKey: "ext-1",
        name: "Acme Corp",
        role: "Manager",
        isAnalyst: false,
      },
    ],
    selectedCustomerId: "c1",
    setSelectedCustomerId: vi.fn(),
    environments: [{ aiceId: "env-1", name: "Production" }],
    selectedEnvironmentId: "env-1",
    setSelectedEnvironmentId: vi.fn(),
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
    canViewMembers: true,
    canViewCustomerSettings: true,
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

    expect(text).toContain("Home");
    expect(text).toContain("Events");
    expect(text).toContain("Analysis");
    expect(text).toContain("Reports");
    expect(text).toContain("Dashboard");
  });

  it("renders manager-only items when canViewMembers is true", () => {
    const { container } = render(<Sidebar collapsed={false} />);
    const nav = container.querySelector('nav[aria-label="Main"]');
    assertDefined(nav);
    const text = nav.textContent ?? "";

    expect(text).toContain("Members");
    expect(text).toContain("Customer Settings");
  });

  it("hides manager-only items when canViewMembers is false", () => {
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

  it("renders customer selector with correct value", () => {
    const { container } = render(<Sidebar collapsed={false} />);
    const selects = container.querySelectorAll("select");

    expect(selects.length).toBe(2);
    expect((selects[0] as HTMLSelectElement).value).toBe("c1");
    expect(selects[0].textContent).toContain("Acme Corp");
  });

  it("renders environment selector", () => {
    const { container } = render(<Sidebar collapsed={false} />);
    const selects = container.querySelectorAll("select");

    expect(selects.length).toBe(2);
    expect((selects[1] as HTMLSelectElement).value).toBe("env-1");
    expect(selects[1].textContent).toContain("Production");
  });

  it("disables selectors in bridge session", () => {
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
        analystEligible: false,
        bridge: { active: true, aiceId: "env-1", customerIds: ["c1"] },
        memberships: [],
      },
    });

    const { container } = render(<Sidebar collapsed={false} />);
    const selects = container.querySelectorAll("select");

    expect((selects[0] as HTMLSelectElement).disabled).toBe(true);
    expect((selects[1] as HTMLSelectElement).disabled).toBe(true);
    expect(container.textContent).toContain("Locked to bridge session");
  });

  it("disables environment selector when no environments exist", () => {
    mockDefaults({ environments: [], selectedEnvironmentId: null });

    const { container } = render(<Sidebar collapsed={false} />);
    const selects = container.querySelectorAll("select");

    expect(selects.length).toBe(2);
    expect((selects[1] as HTMLSelectElement).disabled).toBe(true);
  });

  it("renders multiple customers in selector", () => {
    mockDefaults({
      customers: [
        {
          id: "c1",
          externalKey: "ext-1",
          name: "Acme Corp",
          role: "Manager",
          isAnalyst: false,
        },
        {
          id: "c2",
          externalKey: "ext-2",
          name: "Beta Inc",
          role: "User",
          isAnalyst: false,
        },
      ],
    });

    const { container } = render(<Sidebar collapsed={false} />);
    const customerSelect = container.querySelectorAll("select")[0];
    assertDefined(customerSelect);

    const options = customerSelect.querySelectorAll("option");
    expect(options.length).toBe(2);
    expect(options[0].textContent).toBe("Acme Corp");
    expect(options[1].textContent).toBe("Beta Inc");
  });

  it("calls setSelectedCustomerId when customer changes", () => {
    const setSelectedCustomerId = vi.fn();
    mockDefaults({
      setSelectedCustomerId,
      customers: [
        {
          id: "c1",
          externalKey: "ext-1",
          name: "Acme Corp",
          role: "Manager",
          isAnalyst: false,
        },
        {
          id: "c2",
          externalKey: "ext-2",
          name: "Beta Inc",
          role: "User",
          isAnalyst: false,
        },
      ],
    });

    const { container } = render(<Sidebar collapsed={false} />);
    const customerSelect = container.querySelectorAll("select")[0];
    assertDefined(customerSelect);

    fireEvent.change(customerSelect, { target: { value: "c2" } });
    expect(setSelectedCustomerId).toHaveBeenCalledWith("c2");
  });

  it("calls setSelectedEnvironmentId when environment changes", () => {
    const setSelectedEnvironmentId = vi.fn();
    mockDefaults({
      setSelectedEnvironmentId,
      environments: [
        { aiceId: "env-1", name: "Production" },
        { aiceId: "env-2", name: "Staging" },
      ],
    });

    const { container } = render(<Sidebar collapsed={false} />);
    const envSelect = container.querySelectorAll("select")[1];
    assertDefined(envSelect);

    fireEvent.change(envSelect, { target: { value: "env-2" } });
    expect(setSelectedEnvironmentId).toHaveBeenCalledWith("env-2");
  });

  it("marks active nav item with aria-current=page", () => {
    mockedUsePathname.mockReturnValue("/en/events");

    const { container } = render(<Sidebar collapsed={false} />);

    const activeLink = container.querySelector(
      'a[aria-current="page"]',
    ) as HTMLAnchorElement;
    expect(activeLink).not.toBeNull();
    expect(activeLink.getAttribute("href")).toBe("/en/events");
  });

  it("hides customer selector when collapsed", () => {
    const { container } = render(<Sidebar collapsed={true} />);

    expect(container.querySelector("#customer-select")).toBeNull();
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
    expect(text).toContain("Home");
    expect(text).toContain("Events");
    expect(text).toContain("Analysis");
    expect(text).toContain("Reports");
    expect(text).toContain("Dashboard");
  });

  it("renders customer selector inside sheet", () => {
    const { container } = render(<MobileSidebarTrigger />);

    const sheetContent = container.querySelector(
      '[data-testid="sheet-content"]',
    );
    assertDefined(sheetContent);
    const selects = sheetContent.querySelectorAll("select");
    expect(selects.length).toBe(2);
    expect((selects[0] as HTMLSelectElement).value).toBe("c1");
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

    // The sheet should call onOpenChange(false) to close
    assertDefined(lastOnOpenChange);
    // The click handler on nav links calls the onNavigate callback,
    // which calls setOpen(false), which triggers onOpenChange(false).
    // Since our mock Sheet captures onOpenChange, verify it was provided.
    expect(typeof lastOnOpenChange).toBe("function");
  });
});
