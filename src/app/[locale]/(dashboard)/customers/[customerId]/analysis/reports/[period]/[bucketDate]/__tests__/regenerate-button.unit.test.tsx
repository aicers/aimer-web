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

const CATALOG = [
  { modelName: "openai", model: "gpt-4o", label: "OpenAI GPT-4o" },
  { modelName: "anthropic", model: "claude-3-5", label: "Claude 3.5" },
];

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

  it("omits the model picker when no catalog is supplied (non-analyst path)", () => {
    const { getByTestId, queryByTestId } = render(
      <ReportRegenerateButton
        customerId="c1"
        period="DAILY"
        bucketDate="2025-01-01"
      />,
    );
    fireEvent.click(getByTestId("regenerate-button"));
    expect(queryByTestId("model-select")).toBeNull();
  });

  it("renders the model picker and submits the selected model", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      status: 202,
      json: async () => ({ generation: 4 }),
    });
    vi.stubGlobal("fetch", fetchMock);
    Object.defineProperty(document, "cookie", {
      value: "csrf=tok",
      writable: true,
      configurable: true,
    });

    const { getByTestId } = render(
      <ReportRegenerateButton
        customerId="c1"
        period="DAILY"
        bucketDate="2025-01-01"
        variant={{
          tz: "UTC",
          lang: "en",
          model_name: "openai",
          model: "gpt-4o",
        }}
        models={CATALOG}
      />,
    );
    fireEvent.click(getByTestId("regenerate-button"));
    const select = getByTestId("model-select") as HTMLSelectElement;
    // Default selection is the current variant's model (index 0).
    expect(select.value).toBe("0");
    // Pick the second catalog model and submit.
    fireEvent.change(select, { target: { value: "1" } });
    fireEvent.click(getByTestId("regenerate-confirm"));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());

    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain("model_name=anthropic");
    expect(url).toContain("model=claude-3-5");
    // tz/lang from the active variant are still forwarded.
    expect(url).toContain("tz=UTC");
    expect(url).toContain("lang=en");
    vi.unstubAllGlobals();
  });

  it("preselects the compare-target model for the missing-variant CTA", () => {
    const { getByTestId } = render(
      <ReportRegenerateButton
        customerId="c1"
        period="DAILY"
        bucketDate="2025-01-01"
        variant={{
          tz: "UTC",
          lang: "en",
          model_name: "openai",
          model: "gpt-4o",
        }}
        models={CATALOG}
        defaultModel={{ modelName: "anthropic", model: "claude-3-5" }}
      />,
    );
    fireEvent.click(getByTestId("regenerate-button"));
    const select = getByTestId("model-select") as HTMLSelectElement;
    // The dropdown defaults to the compare target (index 1), not the current.
    expect(select.value).toBe("1");
  });
});
