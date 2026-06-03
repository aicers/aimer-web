// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));

vi.mock("@/hooks/use-customer-context", () => ({
  useCustomerContext: vi.fn(),
}));

vi.mock("@/hooks/use-permissions", () => ({
  usePermissions: vi.fn(),
}));

// The two sections fetch from the API on mount; stub them so this test
// stays focused on the page-level scope/permission gating.
vi.mock("../redaction-ranges-section", () => ({
  RedactionRangesSection: () => <div data-testid="redaction-section" />,
}));
vi.mock("../retention-section", () => ({
  RetentionSection: () => <div data-testid="retention-section" />,
}));

import { useCustomerContext } from "@/hooks/use-customer-context";
import { usePermissions } from "@/hooks/use-permissions";
import CustomerSettingsPage from "../page";

const mockedUseCustomerContext = vi.mocked(useCustomerContext);
const mockedUsePermissions = vi.mocked(usePermissions);

function arrange(opts: {
  singleCustomerId: string | null;
  canViewCustomerSettings: boolean;
  canViewRedactionRanges?: boolean;
  canViewRetention?: boolean;
}) {
  mockedUseCustomerContext.mockReturnValue({
    singleCustomerId: opts.singleCustomerId,
  } as ReturnType<typeof useCustomerContext>);
  mockedUsePermissions.mockReturnValue({
    canViewCustomerSettings: opts.canViewCustomerSettings,
    canViewRedactionRanges: opts.canViewRedactionRanges ?? false,
    canWriteRedactionRanges: false,
    canViewRetention: opts.canViewRetention ?? false,
    canWriteRetention: false,
  } as ReturnType<typeof usePermissions>);
}

afterEach(() => cleanup());

describe("CustomerSettingsPage", () => {
  beforeEach(() => {
    mockedUseCustomerContext.mockReset();
    mockedUsePermissions.mockReset();
  });

  it("shows the scope-required notice under a multi-/all-scope", () => {
    arrange({ singleCustomerId: null, canViewCustomerSettings: true });

    render(<CustomerSettingsPage />);

    expect(screen.getByText("scopeRequired")).toBeDefined();
    expect(screen.queryByTestId("redaction-section")).toBeNull();
    expect(screen.queryByTestId("retention-section")).toBeNull();
  });

  it("shows forbidden when a single customer is in scope but access is denied", () => {
    arrange({ singleCustomerId: "c1", canViewCustomerSettings: false });

    render(<CustomerSettingsPage />);

    expect(screen.getByText("forbidden")).toBeDefined();
    expect(screen.queryByText("scopeRequired")).toBeNull();
  });

  it("renders the sections for a single in-scope customer with access", () => {
    arrange({
      singleCustomerId: "c1",
      canViewCustomerSettings: true,
      canViewRedactionRanges: true,
      canViewRetention: true,
    });

    render(<CustomerSettingsPage />);

    expect(screen.queryByText("scopeRequired")).toBeNull();
    expect(screen.getByTestId("redaction-section")).toBeDefined();
    expect(screen.getByTestId("retention-section")).toBeDefined();
  });
});
