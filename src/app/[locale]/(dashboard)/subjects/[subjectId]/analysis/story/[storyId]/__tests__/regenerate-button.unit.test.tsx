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

import { StoryRegenerateButton } from "../regenerate-button";

describe("StoryRegenerateButton", () => {
  afterEach(cleanup);

  it("renders the trigger label via next-intl", () => {
    const { getByTestId } = render(
      <StoryRegenerateButton customerId="c1" storyId="s1" />,
    );
    expect(getByTestId("regenerate-button").textContent).toBe(
      "TR:regenerate.button",
    );
  });

  it("opens a localized confirmation modal", () => {
    const { getByTestId, queryByTestId } = render(
      <StoryRegenerateButton customerId="c1" storyId="s1" />,
    );
    expect(queryByTestId("regenerate-modal")).toBeNull();

    fireEvent.click(getByTestId("regenerate-button"));

    const modal = getByTestId("regenerate-modal");
    // The dialog title doubles as the localized accessibility label.
    expect(modal.getAttribute("aria-label")).toBe("TR:regenerate.storyTitle");
    expect(modal.textContent).toContain("TR:regenerate.storyTitle");
    // The body keeps its <code>superseded_at</code> markup via t.rich.
    expect(modal.textContent).toContain("RICH:regenerate.storyBody");
    expect(modal.querySelector("code")?.textContent).toBe("superseded_at");
    expect(getByTestId("regenerate-confirm").textContent).toBe(
      "TR:regenerate.button",
    );
  });

  it("omits the model picker when no catalog is supplied", () => {
    const { getByTestId, queryByTestId } = render(
      <StoryRegenerateButton customerId="c1" storyId="s1" />,
    );
    fireEvent.click(getByTestId("regenerate-button"));
    expect(queryByTestId("model-select")).toBeNull();
  });

  it("renders the model picker and submits the selected model + lang", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      status: 202,
      json: async () => ({ generation: 2 }),
    });
    vi.stubGlobal("fetch", fetchMock);
    Object.defineProperty(document, "cookie", {
      value: "csrf=tok",
      writable: true,
      configurable: true,
    });

    const { getByTestId } = render(
      <StoryRegenerateButton
        customerId="c1"
        storyId="s1"
        variant={{ lang: "ENGLISH", modelName: "openai", model: "gpt-4o" }}
        models={[
          { modelName: "openai", model: "gpt-4o", label: "OpenAI GPT-4o" },
          { modelName: "anthropic", model: "claude-3-5", label: "Claude 3.5" },
        ]}
      />,
    );
    fireEvent.click(getByTestId("regenerate-button"));
    const select = getByTestId("model-select") as HTMLSelectElement;
    expect(select.value).toBe("0");
    fireEvent.change(select, { target: { value: "1" } });
    fireEvent.click(getByTestId("regenerate-confirm"));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());

    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain("model_name=anthropic");
    expect(url).toContain("model=claude-3-5");
    expect(url).toContain("lang=ENGLISH");
    // The story endpoint rejects `tz`; it must never be sent.
    expect(url).not.toContain("tz=");
    vi.unstubAllGlobals();
  });
});
