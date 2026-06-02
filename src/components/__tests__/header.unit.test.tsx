// @vitest-environment jsdom
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

vi.mock("next/image", () => ({
  default: ({
    src,
    alt,
    ...props
  }: {
    src: string | { src: string };
    alt: string;
  }) => {
    const resolved = typeof src === "string" ? src : src.src;
    // biome-ignore lint/performance/noImgElement: test stub for next/image
    return <img src={resolved} alt={alt} {...props} />;
  },
}));

vi.mock("next-themes", () => ({
  useTheme: vi.fn(() => ({ resolvedTheme: "gray-light" })),
}));

vi.mock("next-intl", () => {
  const sidebarMap: Record<string, string> = {
    expandSidebar: "Expand sidebar",
    collapseSidebar: "Collapse sidebar",
  };
  const authMap: Record<string, string> = {
    signOut: "Sign Out",
  };
  return {
    useTranslations: vi.fn((ns: string) => {
      if (ns === "sidebar") return (key: string) => sidebarMap[key] ?? key;
      if (ns === "auth") return (key: string) => authMap[key] ?? key;
      return (key: string) => key;
    }),
  };
});

vi.mock("@/components/locale-switcher", () => ({
  LocaleSwitcher: () => <div data-testid="locale-switcher" />,
}));

vi.mock("@/components/theme-toggle", () => ({
  ThemeToggle: () => <div data-testid="theme-toggle" />,
}));

vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="dropdown-menu">{children}</div>
  ),
  DropdownMenuTrigger: ({
    children,
  }: {
    children: React.ReactNode;
    asChild?: boolean;
  }) => <div data-testid="dropdown-trigger">{children}</div>,
  DropdownMenuContent: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="dropdown-content">{children}</div>
  ),
  DropdownMenuItem: ({
    children,
    onSelect,
  }: {
    children: React.ReactNode;
    onSelect?: () => void;
  }) => (
    <button type="button" data-testid="dropdown-item" onClick={onSelect}>
      {children}
    </button>
  ),
  DropdownMenuSeparator: () => <hr />,
}));

import { AppHeader } from "../header";

const defaultProps = {
  collapsed: false,
  onToggleSidebar: vi.fn(),
  homeHref: "/en",
  onSignOut: vi.fn(),
  mobileMenuTrigger: (
    <button type="button" data-testid="mobile-trigger">
      Menu
    </button>
  ),
};

describe("AppHeader", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it("renders Clumit Insight branding with link to homeHref", () => {
    const { container } = render(<AppHeader {...defaultProps} />);

    const link = container.querySelector('a[href="/en"]');
    expect(link).not.toBeNull();
    const logo = link?.querySelector('img[alt="Clumit Insight"]');
    expect(logo).not.toBeNull();
  });

  it("renders mobile menu trigger", () => {
    const { container } = render(<AppHeader {...defaultProps} />);

    const trigger = container.querySelector('[data-testid="mobile-trigger"]');
    expect(trigger).not.toBeNull();
  });

  it("renders context label when provided", () => {
    const { container } = render(
      <AppHeader {...defaultProps} contextLabel={<span>Admin</span>} />,
    );

    expect(container.textContent).toContain("Admin");
  });

  it("does not render context label when omitted", () => {
    const { container } = render(<AppHeader {...defaultProps} />);

    // "Admin" should not appear in header text
    const header = container.querySelector("header");
    expect(header?.textContent).not.toContain("Admin");
  });

  it("renders user profile when user is provided", () => {
    const { container } = render(
      <AppHeader
        {...defaultProps}
        user={{ displayName: "Test User", email: "test@example.com" }}
      />,
    );

    expect(container.textContent).toContain("Test User");
    expect(container.textContent).toContain("test@example.com");
    expect(container.textContent).toContain("T"); // avatar initial
  });

  it("hides user profile when user is null", () => {
    const { container } = render(<AppHeader {...defaultProps} user={null} />);

    expect(container.textContent).not.toContain("Test User");
  });

  it("hides user profile when user is omitted", () => {
    const { container } = render(<AppHeader {...defaultProps} />);

    const header = container.querySelector("header");
    expect(header?.textContent).not.toContain("Test User");
  });

  it("renders user without email when email is null", () => {
    const { container } = render(
      <AppHeader
        {...defaultProps}
        user={{ displayName: "Admin", email: null }}
      />,
    );

    expect(container.textContent).toContain("Admin");
    expect(container.textContent).toContain("A"); // avatar initial
  });

  it("calls onToggleSidebar when hamburger is clicked", () => {
    const onToggle = vi.fn();
    const { container } = render(
      <AppHeader {...defaultProps} onToggleSidebar={onToggle} />,
    );

    const toggleBtn = container.querySelector(
      'button[aria-label="Collapse sidebar"]',
    ) as HTMLElement;
    expect(toggleBtn).not.toBeNull();
    fireEvent.click(toggleBtn);

    expect(onToggle).toHaveBeenCalledOnce();
  });

  it("shows expand label when collapsed", () => {
    const { container } = render(
      <AppHeader {...defaultProps} collapsed={true} />,
    );

    const btn = container.querySelector('button[aria-label="Expand sidebar"]');
    expect(btn).not.toBeNull();
  });

  it("shows collapse label when expanded", () => {
    const { container } = render(
      <AppHeader {...defaultProps} collapsed={false} />,
    );

    const btn = container.querySelector(
      'button[aria-label="Collapse sidebar"]',
    );
    expect(btn).not.toBeNull();
  });

  it("calls onSignOut when sign out is clicked in dropdown", () => {
    const onSignOut = vi.fn();
    const { container } = render(
      <AppHeader
        {...defaultProps}
        onSignOut={onSignOut}
        user={{ displayName: "Test User", email: "test@example.com" }}
      />,
    );

    // Find the dropdown item that contains the sign out text
    const dropdownItem = container.querySelector(
      '[data-testid="dropdown-item"]',
    ) as HTMLElement;
    expect(dropdownItem).not.toBeNull();
    fireEvent.click(dropdownItem);

    expect(onSignOut).toHaveBeenCalledOnce();
  });

  it("renders theme toggle and locale switcher", () => {
    const { container } = render(<AppHeader {...defaultProps} />);

    expect(
      container.querySelector('[data-testid="theme-toggle"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-testid="locale-switcher"]'),
    ).not.toBeNull();
  });
});
