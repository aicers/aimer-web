// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockApiFetch = vi.fn();
vi.mock("@/lib/api/client", () => ({
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
}));

const mockIsEnabled = vi.fn(() => false);
vi.mock("@/lib/redaction/feature-flag", () => ({
  isRedactionJobsEnabled: () => mockIsEnabled(),
}));

// Stable translation function — returning a fresh closure on each
// render would re-fire the component's `reload` useEffect, wiping
// the form back to "loading" mid-test.
const t = (key: string) => key;
vi.mock("next-intl", () => ({
  useTranslations: () => t,
}));

vi.mock("@/components/ui/tooltip", () => ({
  TooltipProvider: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
  TooltipContent: ({ children }: { children: React.ReactNode }) => (
    <span data-testid="tooltip">{children}</span>
  ),
}));

import { RedactionRangesSection } from "../redaction-ranges-section";

beforeEach(() => {
  mockApiFetch.mockReset();
  mockIsEnabled.mockReturnValue(false);
});

afterEach(() => {
  cleanup();
});

describe("RedactionRangesSection", () => {
  function arrangeRanges(ranges: Array<{ id: string; cidr: string }>): void {
    mockApiFetch.mockImplementation((_url: string, opts?: RequestInit) => {
      if (!opts || opts.method === undefined) {
        return Promise.resolve({
          ranges: ranges.map((r) => ({
            id: r.id,
            cidr: r.cidr,
            ipVersion: r.cidr.includes(":") ? 6 : 4,
            createdAt: "2026-01-01",
          })),
        });
      }
      return Promise.resolve(undefined);
    });
  }

  it("renders the empty banner when no ranges are registered", async () => {
    arrangeRanges([]);
    render(<RedactionRangesSection customerId="cust-1" canWrite={true} />);
    await waitFor(() => expect(screen.getByRole("status")).toBeDefined());
    expect(screen.getByRole("status").textContent).toBe("rangesEmptyBanner");
  });

  it("hides the add form and delete buttons for read-only callers", async () => {
    arrangeRanges([{ id: "r1", cidr: "203.0.113.0/24" }]);
    render(<RedactionRangesSection customerId="cust-1" canWrite={false} />);
    await waitFor(() =>
      expect(screen.getByText("203.0.113.0/24")).toBeDefined(),
    );
    expect(screen.queryByLabelText("rangeAddLabel")).toBeNull();
    expect(screen.queryByRole("button", { name: "rangeAddButton" })).toBeNull();
    // No delete buttons should be rendered.
    expect(
      screen.queryByRole("button", { name: /rangeDeleteAriaLabel/ }),
    ).toBeNull();
  });

  it("shows the add form and delete buttons for write-capable callers", async () => {
    arrangeRanges([{ id: "r1", cidr: "203.0.113.0/24" }]);
    render(<RedactionRangesSection customerId="cust-1" canWrite={true} />);
    await waitFor(() =>
      expect(screen.getByText("203.0.113.0/24")).toBeDefined(),
    );
    expect(screen.getByLabelText("rangeAddLabel")).toBeDefined();
    expect(
      screen.getByRole("button", { name: "rangeAddButton" }),
    ).toBeDefined();
  });

  it("renders the Apply-to-existing-data button as disabled with the feature-flag tooltip", async () => {
    arrangeRanges([]);
    render(<RedactionRangesSection customerId="cust-1" canWrite={true} />);
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "applyExistingButton" }),
      ).toBeDefined(),
    );
    const applyBtn = screen.getByRole("button", {
      name: "applyExistingButton",
    }) as HTMLButtonElement;
    expect(applyBtn.disabled).toBe(true);
    expect(screen.getByTestId("tooltip").textContent).toBe(
      "applyExistingDisabledTooltip",
    );
  });

  it("hides the Apply button entirely for read-only callers", async () => {
    arrangeRanges([]);
    render(<RedactionRangesSection customerId="cust-1" canWrite={false} />);
    await waitFor(() => expect(screen.getByRole("status")).toBeDefined());
    expect(
      screen.queryByRole("button", { name: "applyExistingButton" }),
    ).toBeNull();
  });

  it("enables the Apply button (no tooltip) when the feature gate is on", async () => {
    mockIsEnabled.mockReturnValue(true);
    arrangeRanges([]);
    render(<RedactionRangesSection customerId="cust-1" canWrite={true} />);
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "applyExistingButton" }),
      ).toBeDefined(),
    );
    const applyBtn = screen.getByRole("button", {
      name: "applyExistingButton",
    }) as HTMLButtonElement;
    expect(applyBtn.disabled).toBe(false);
    // The disabled-state tooltip wrapper should not be rendered when
    // the gate is on — the button is wired up directly.
    expect(screen.queryByTestId("tooltip")).toBeNull();
  });

  it("posts to /redaction-jobs after the user confirms when the gate is on", async () => {
    mockIsEnabled.mockReturnValue(true);
    mockApiFetch.mockImplementation((url: string, opts?: RequestInit) => {
      if (url.endsWith("/redaction-ranges") && !opts) {
        return Promise.resolve({
          ranges: [
            {
              id: "r1",
              cidr: "203.0.113.0/24",
              ipVersion: 4,
              createdAt: "2026-01-01",
            },
          ],
        });
      }
      if (url.endsWith("/redaction-jobs/preview")) {
        return Promise.resolve({
          stale_row_count: 42,
          estimated_duration_seconds: 5,
          target_policy_version: "engine:1.0.0|ranges:abcd",
        });
      }
      if (url.endsWith("/redaction-jobs") && opts?.method === "POST") {
        return Promise.resolve({
          job_id: "j-1",
          status: "queued",
          target_policy_version: "engine:1.0.0|ranges:abcd",
        });
      }
      return Promise.resolve(undefined);
    });
    render(<RedactionRangesSection customerId="cust-1" canWrite={true} />);
    await waitFor(() =>
      expect(screen.getByText("203.0.113.0/24")).toBeDefined(),
    );

    fireEvent.click(
      screen.getByRole("button", { name: "applyExistingButton" }),
    );

    await waitFor(() => expect(screen.getByRole("dialog")).toBeDefined());
    fireEvent.click(
      screen.getByRole("button", { name: "applyExistingConfirm" }),
    );

    await waitFor(() => {
      const triggerCalls = mockApiFetch.mock.calls.filter(
        (c) =>
          (c[0] as string).endsWith("/redaction-jobs") &&
          (c[1] as RequestInit | undefined)?.method === "POST",
      );
      expect(triggerCalls.length).toBe(1);
    });
    await waitFor(() =>
      expect(screen.getByTestId("trigger-status")).toBeDefined(),
    );
  });

  it("surfaces an error and hides the Run button when the preview load fails", async () => {
    mockIsEnabled.mockReturnValue(true);
    mockApiFetch.mockImplementation((url: string, opts?: RequestInit) => {
      if (url.endsWith("/redaction-ranges") && !opts) {
        return Promise.resolve({
          ranges: [
            {
              id: "r1",
              cidr: "203.0.113.0/24",
              ipVersion: 4,
              createdAt: "2026-01-01",
            },
          ],
        });
      }
      if (url.endsWith("/redaction-jobs/preview")) {
        return Promise.reject(new Error("preview_failed"));
      }
      return Promise.resolve(undefined);
    });
    render(<RedactionRangesSection customerId="cust-1" canWrite={true} />);
    await waitFor(() =>
      expect(screen.getByText("203.0.113.0/24")).toBeDefined(),
    );

    fireEvent.click(
      screen.getByRole("button", { name: "applyExistingButton" }),
    );

    await waitFor(() =>
      expect(screen.getByTestId("preview-error")).toBeDefined(),
    );
    // The Run button must NOT be rendered while we lack a real
    // preview response — the dialog cannot legitimately confirm a
    // job without a server-computed row count + policy version.
    expect(
      screen.queryByRole("button", { name: "applyExistingConfirm" }),
    ).toBeNull();
    // The trigger endpoint must not have been called.
    const triggerCalls = mockApiFetch.mock.calls.filter(
      (c) =>
        (c[0] as string).endsWith("/redaction-jobs") &&
        (c[1] as RequestInit | undefined)?.method === "POST",
    );
    expect(triggerCalls.length).toBe(0);
  });

  it("submits the typed CIDR via POST when Add is clicked", async () => {
    arrangeRanges([]);
    render(<RedactionRangesSection customerId="cust-1" canWrite={true} />);
    await waitFor(() =>
      expect(screen.getByLabelText("rangeAddLabel")).toBeDefined(),
    );
    const input = screen.getByLabelText("rangeAddLabel") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "203.0.113.0/24" } });
    fireEvent.click(screen.getByRole("button", { name: "rangeAddButton" }));
    await waitFor(() => {
      const postCalls = mockApiFetch.mock.calls.filter(
        (c) => (c[1] as RequestInit | undefined)?.method === "POST",
      );
      expect(postCalls.length).toBe(1);
      expect(JSON.parse(postCalls[0][1].body as string)).toEqual({
        cidr: "203.0.113.0/24",
      });
    });
  });
});
