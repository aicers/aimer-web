// @vitest-environment jsdom
//
// #463 — EventRegenerateButton. Unlike the story button (which queues an
// async job), event regenerate is synchronous: on 200 {generation} the
// button navigates the current user to the new generation, building the
// URL from the CURRENT locale + variant params client-side (the endpoint
// is locale-agnostic).

import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const push = vi.fn();
const refresh = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, refresh }),
}));

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

import { EventRegenerateButton } from "../regenerate-button";

const VARIANT = { lang: "ENGLISH", modelName: "openai", model: "gpt-4o" };

// #464 — the catalog the analyst-only model picker offers. The first entry is
// the current variant's model; the second is a non-current model the picker can
// submit.
const CATALOG = [
  { modelName: "openai", model: "gpt-4o", label: "OpenAI GPT-4o" },
  { modelName: "anthropic", model: "claude-3-5", label: "Claude 3.5" },
];

function renderButton(
  props: Partial<React.ComponentProps<typeof EventRegenerateButton>> = {},
) {
  return render(
    <EventRegenerateButton
      locale="ko"
      customerId="c1"
      aiceId="aice-1"
      eventKey="1001"
      variant={VARIANT}
      {...props}
    />,
  );
}

beforeEach(() => {
  push.mockReset();
  refresh.mockReset();
  Object.defineProperty(document, "cookie", {
    value: "csrf=tok123",
    writable: true,
    configurable: true,
  });
});
afterEach(cleanup);

describe("EventRegenerateButton", () => {
  it("renders the trigger and opens a localized modal with the cost warning", () => {
    const { getByTestId, queryByTestId } = renderButton();
    expect(getByTestId("event-regenerate-button").textContent).toBe(
      "TR:regenerate.button",
    );
    expect(queryByTestId("event-regenerate-modal")).toBeNull();
    fireEvent.click(getByTestId("event-regenerate-button"));
    const modal = getByTestId("event-regenerate-modal");
    expect(modal.getAttribute("aria-label")).toBe("TR:regenerate.eventTitle");
    expect(modal.textContent).toContain("RICH:regenerate.eventBody");
    expect(modal.querySelector("code")?.textContent).toBe("superseded_at");
  });

  it("POSTs the variant and navigates to the new generation in the CURRENT locale", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      status: 200,
      json: async () => ({ generation: 3 }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const { getByTestId } = renderButton();
    fireEvent.click(getByTestId("event-regenerate-button"));
    fireEvent.click(getByTestId("event-regenerate-confirm"));

    await waitFor(() => expect(push).toHaveBeenCalled());

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(
      "/api/subjects/c1/aice/aice-1/events/1001/regenerate?lang=ENGLISH&model_name=openai&model=gpt-4o",
    );
    expect(init.method).toBe("POST");
    expect(init.headers["x-csrf-token"]).toBe("tok123");

    // Navigates to the new generation using the CURRENT locale (ko), not a
    // hardcoded `en`.
    expect(push).toHaveBeenCalledWith(
      "/ko/subjects/c1/aice/aice-1/events/1001/analysis?lang=en&model_name=openai&model=gpt-4o&generation=3",
    );
    expect(refresh).toHaveBeenCalled();
    expect(getByTestId("event-regenerate-status").textContent).toContain(
      "TR:regenerate.navigating",
    );
  });

  it("renders the model picker only when a catalog is provided (#464)", () => {
    const without = renderButton();
    fireEvent.click(without.getByTestId("event-regenerate-button"));
    expect(without.queryByTestId("model-select")).toBeNull();
    cleanup();

    const withCatalog = renderButton({ models: CATALOG });
    fireEvent.click(withCatalog.getByTestId("event-regenerate-button"));
    expect(withCatalog.getByTestId("model-select")).toBeTruthy();
  });

  it("submits a chosen NON-current model and navigates to that variant (#464)", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      status: 200,
      json: async () => ({ generation: 4 }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const { getByTestId } = renderButton({ models: CATALOG });
    fireEvent.click(getByTestId("event-regenerate-button"));
    // Pick the second catalog entry (a non-current model).
    fireEvent.change(getByTestId("model-select"), { target: { value: "1" } });
    fireEvent.click(getByTestId("event-regenerate-confirm"));

    await waitFor(() => expect(push).toHaveBeenCalled());

    // The POST carries the CHOSEN model, not the originally-open one; `lang`
    // stays the current variant's (model axis only).
    const [url] = fetchMock.mock.calls[0];
    expect(url).toBe(
      "/api/subjects/c1/aice/aice-1/events/1001/regenerate?lang=ENGLISH&model_name=anthropic&model=claude-3-5",
    );
    // Navigation points at the chosen model's new generation, current locale.
    expect(push).toHaveBeenCalledWith(
      "/ko/subjects/c1/aice/aice-1/events/1001/analysis?lang=en&model_name=anthropic&model=claude-3-5&generation=4",
    );
  });

  it("preselects the compare-target model via defaultModel (#464)", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      status: 200,
      json: async () => ({ generation: 5 }),
    });
    vi.stubGlobal("fetch", fetchMock);

    // The compare "not generated" CTA seeds the picker with the compare target.
    const { getByTestId } = renderButton({
      models: CATALOG,
      defaultModel: { modelName: "anthropic", model: "claude-3-5" },
    });
    fireEvent.click(getByTestId("event-regenerate-button"));
    // Without touching the dropdown, submit goes to the preselected target.
    fireEvent.click(getByTestId("event-regenerate-confirm"));

    await waitFor(() => expect(push).toHaveBeenCalled());
    const [url] = fetchMock.mock.calls[0];
    expect(url).toBe(
      "/api/subjects/c1/aice/aice-1/events/1001/regenerate?lang=ENGLISH&model_name=anthropic&model=claude-3-5",
    );
  });

  it("resyncs the preselected model when defaultModel changes without a remount (#464)", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      status: 200,
      json: async () => ({ generation: 6 }),
    });
    vi.stubGlobal("fetch", fetchMock);

    // The compare "not generated" CTA seeds the picker with model A. A compare
    // selector switch to model B is a search-param soft-nav that keeps this
    // client component mounted (no remount), so re-render with the new
    // defaultModel rather than mounting a fresh tree.
    const { getByTestId, rerender } = render(
      <EventRegenerateButton
        locale="ko"
        customerId="c1"
        aiceId="aice-1"
        eventKey="1001"
        variant={VARIANT}
        models={CATALOG}
        defaultModel={{ modelName: "openai", model: "gpt-4o" }}
      />,
    );
    rerender(
      <EventRegenerateButton
        locale="ko"
        customerId="c1"
        aiceId="aice-1"
        eventKey="1001"
        variant={VARIANT}
        models={CATALOG}
        defaultModel={{ modelName: "anthropic", model: "claude-3-5" }}
      />,
    );

    fireEvent.click(getByTestId("event-regenerate-button"));
    // Submit without touching the dropdown: it must POST model B (the new
    // target), not the stale A.
    fireEvent.click(getByTestId("event-regenerate-confirm"));

    await waitFor(() => expect(push).toHaveBeenCalled());
    const [url] = fetchMock.mock.calls[0];
    expect(url).toBe(
      "/api/subjects/c1/aice/aice-1/events/1001/regenerate?lang=ENGLISH&model_name=anthropic&model=claude-3-5",
    );
  });

  it("shows an error banner and does not navigate on a non-200 response", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      status: 403,
      json: async () => ({ error: "bridge_write_blocked" }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const { getByTestId } = renderButton();
    fireEvent.click(getByTestId("event-regenerate-button"));
    fireEvent.click(getByTestId("event-regenerate-confirm"));

    await waitFor(() =>
      expect(getByTestId("event-regenerate-error")).toBeTruthy(),
    );
    expect(push).not.toHaveBeenCalled();
    expect(getByTestId("event-regenerate-error").textContent).toContain(
      "bridge_write_blocked",
    );
  });
});
