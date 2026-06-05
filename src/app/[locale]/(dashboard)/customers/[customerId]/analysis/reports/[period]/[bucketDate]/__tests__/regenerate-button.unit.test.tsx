// @vitest-environment jsdom
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

// The regenerate chrome must resolve through next-intl, so the mock maps every
// key to a recognizable sentinel. Any leftover hardcoded English would show up
// as literal English text instead of a `TR:` / `RICH:` sentinel.
vi.mock("next-intl", () => {
  const t = (key: string, vars?: Record<string, unknown>) =>
    vars ? `TR:${key}:${JSON.stringify(vars)}` : `TR:${key}`;
  t.rich = (
    key: string,
    tags: Record<string, (chunks: React.ReactNode) => React.ReactNode>,
  ) => (
    <span>
      RICH:{key}
      {tags.code?.("superseded_at")}
    </span>
  );
  return { useTranslations: vi.fn(() => t) };
});

import { ReportRegenerateButton } from "../regenerate-button";

describe("ReportRegenerateButton", () => {
  afterEach(cleanup);

  it("renders the trigger label via next-intl", () => {
    const { getByTestId } = render(
      <ReportRegenerateButton
        customerId="c1"
        period="weekly"
        bucketDate="2025-01-01"
      />,
    );
    expect(getByTestId("regenerate-button").textContent).toBe(
      "TR:regenerate.button",
    );
  });

  it("opens a localized confirmation modal", () => {
    const { getByTestId, queryByTestId } = render(
      <ReportRegenerateButton
        customerId="c1"
        period="weekly"
        bucketDate="2025-01-01"
      />,
    );
    expect(queryByTestId("regenerate-modal")).toBeNull();

    fireEvent.click(getByTestId("regenerate-button"));

    const modal = getByTestId("regenerate-modal");
    // The dialog title doubles as the localized accessibility label.
    expect(modal.getAttribute("aria-label")).toBe("TR:regenerate.reportTitle");
    expect(modal.textContent).toContain("TR:regenerate.reportTitle");
    // The body keeps its <code>superseded_at</code> markup via t.rich.
    expect(modal.textContent).toContain("RICH:regenerate.reportBody");
    expect(modal.querySelector("code")?.textContent).toBe("superseded_at");
    expect(getByTestId("regenerate-confirm").textContent).toBe(
      "TR:regenerate.button",
    );
  });
});
