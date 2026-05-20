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

// Stable translation function — returning a fresh closure on each
// render would re-fire the component's `reload` useEffect (the
// `t` dep would change every render), wiping the form back to
// "loading" mid-test.
const t = (key: string) => key;
vi.mock("next-intl", () => ({
  useTranslations: () => t,
}));

import { RetentionSection } from "../retention-section";

beforeEach(() => {
  mockApiFetch.mockReset();
});

afterEach(() => {
  cleanup();
});

describe("RetentionSection", () => {
  function arrangeServer(payload: {
    ingestion_days: number;
    analysis_days: number | null;
  }): void {
    mockApiFetch.mockImplementation((_url: string, opts?: RequestInit) => {
      if (!opts || opts.method === undefined) {
        // GET reload
        return Promise.resolve(payload);
      }
      return Promise.resolve(undefined);
    });
  }

  it("renders inputs disabled and hides the save button when canWrite is false", async () => {
    arrangeServer({ ingestion_days: 365, analysis_days: 1095 });
    render(<RetentionSection customerId="cust-1" canWrite={false} />);
    await waitFor(() =>
      expect(screen.getByLabelText("ingestionDaysLabel")).toBeDefined(),
    );
    const ingestion = screen.getByLabelText(
      "ingestionDaysLabel",
    ) as HTMLInputElement;
    expect(ingestion.disabled).toBe(true);
    expect(screen.queryByRole("button", { name: "save" })).toBeNull();
  });

  it("shows save button and enables inputs when canWrite is true", async () => {
    arrangeServer({ ingestion_days: 365, analysis_days: 1095 });
    render(<RetentionSection customerId="cust-1" canWrite={true} />);
    await waitFor(() =>
      expect(screen.getByLabelText("ingestionDaysLabel")).toBeDefined(),
    );
    const ingestion = screen.getByLabelText(
      "ingestionDaysLabel",
    ) as HTMLInputElement;
    expect(ingestion.disabled).toBe(false);
    expect(screen.getByRole("button", { name: "save" })).toBeDefined();
  });

  it("prompts for confirmation when shortening ingestion_days", async () => {
    arrangeServer({ ingestion_days: 365, analysis_days: 1095 });
    render(<RetentionSection customerId="cust-1" canWrite={true} />);
    await waitFor(() =>
      expect(screen.getByLabelText("ingestionDaysLabel")).toBeDefined(),
    );
    const ingestion = screen.getByLabelText(
      "ingestionDaysLabel",
    ) as HTMLInputElement;
    fireEvent.change(ingestion, { target: { value: "60" } });
    fireEvent.click(screen.getByRole("button", { name: "save" }));
    await waitFor(() => expect(screen.getByRole("alertdialog")).toBeDefined());
    // Server PUT must NOT have been called yet (only the initial GET).
    const writeCalls = mockApiFetch.mock.calls.filter(
      (c) => (c[1] as RequestInit | undefined)?.method === "PUT",
    );
    expect(writeCalls.length).toBe(0);
  });

  it("prompts for confirmation when switching unlimited (null) to a finite value", async () => {
    arrangeServer({ ingestion_days: 365, analysis_days: null });
    render(<RetentionSection customerId="cust-1" canWrite={true} />);
    await waitFor(() =>
      expect(screen.getByLabelText("analysisDaysUnlimitedLabel")).toBeDefined(),
    );
    const unlimited = screen.getByLabelText(
      "analysisDaysUnlimitedLabel",
    ) as HTMLInputElement;
    expect(unlimited.checked).toBe(true);
    fireEvent.click(unlimited);
    const analysis = screen.getByLabelText(
      "analysisDaysLabel",
    ) as HTMLInputElement;
    fireEvent.change(analysis, { target: { value: "365" } });
    fireEvent.click(screen.getByRole("button", { name: "save" }));
    await waitFor(() => expect(screen.getByRole("alertdialog")).toBeDefined());
  });

  it("saves without confirmation when lengthening (finite → unlimited)", async () => {
    arrangeServer({ ingestion_days: 365, analysis_days: 90 });
    render(<RetentionSection customerId="cust-1" canWrite={true} />);
    await waitFor(() =>
      expect(screen.getByLabelText("analysisDaysUnlimitedLabel")).toBeDefined(),
    );
    fireEvent.click(screen.getByLabelText("analysisDaysUnlimitedLabel"));
    fireEvent.click(screen.getByRole("button", { name: "save" }));
    await waitFor(() => {
      const writeCalls = mockApiFetch.mock.calls.filter(
        (c) => (c[1] as RequestInit | undefined)?.method === "PUT",
      );
      expect(writeCalls.length).toBe(1);
      expect(JSON.parse(writeCalls[0][1].body as string)).toEqual({
        ingestion_days: 365,
        analysis_days: null,
      });
    });
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("uses the finite-window copy when shortening ingestion_days while analysis remains unlimited", async () => {
    arrangeServer({ ingestion_days: 365, analysis_days: null });
    render(<RetentionSection customerId="cust-1" canWrite={true} />);
    await waitFor(() =>
      expect(screen.getByLabelText("analysisDaysUnlimitedLabel")).toBeDefined(),
    );
    const unlimited = screen.getByLabelText(
      "analysisDaysUnlimitedLabel",
    ) as HTMLInputElement;
    expect(unlimited.checked).toBe(true);
    const ingestion = screen.getByLabelText(
      "ingestionDaysLabel",
    ) as HTMLInputElement;
    fireEvent.change(ingestion, { target: { value: "180" } });
    fireEvent.click(screen.getByRole("button", { name: "save" }));
    const dialog = await screen.findByRole("alertdialog");
    // The actual destructive change is the ingestion window — analysis is
    // still unlimited — so the generic shorten-window copy applies, not
    // the unlimited→finite copy.
    expect(dialog.textContent).toContain("retentionConfirmShortenFinite");
    expect(dialog.textContent).not.toContain(
      "retentionConfirmShortenUnlimited",
    );
  });

  it("uses the unlimited→finite copy only when analysis_days transitions away from null", async () => {
    arrangeServer({ ingestion_days: 365, analysis_days: null });
    render(<RetentionSection customerId="cust-1" canWrite={true} />);
    await waitFor(() =>
      expect(screen.getByLabelText("analysisDaysUnlimitedLabel")).toBeDefined(),
    );
    const unlimited = screen.getByLabelText(
      "analysisDaysUnlimitedLabel",
    ) as HTMLInputElement;
    fireEvent.click(unlimited);
    const analysis = screen.getByLabelText(
      "analysisDaysLabel",
    ) as HTMLInputElement;
    fireEvent.change(analysis, { target: { value: "365" } });
    fireEvent.click(screen.getByRole("button", { name: "save" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog.textContent).toContain("retentionConfirmShortenUnlimited");
  });

  it("uses snake_case in the PUT body (issue #252 API contract)", async () => {
    arrangeServer({ ingestion_days: 365, analysis_days: 90 });
    render(<RetentionSection customerId="cust-1" canWrite={true} />);
    await waitFor(() =>
      expect(screen.getByLabelText("ingestionDaysLabel")).toBeDefined(),
    );
    const ingestion = screen.getByLabelText(
      "ingestionDaysLabel",
    ) as HTMLInputElement;
    fireEvent.change(ingestion, { target: { value: "400" } });
    fireEvent.click(screen.getByRole("button", { name: "save" }));
    await waitFor(() => {
      const writeCalls = mockApiFetch.mock.calls.filter(
        (c) => (c[1] as RequestInit | undefined)?.method === "PUT",
      );
      expect(writeCalls.length).toBe(1);
      const body = JSON.parse(writeCalls[0][1].body as string);
      expect(Object.keys(body).sort()).toEqual([
        "analysis_days",
        "ingestion_days",
      ]);
    });
  });
});
