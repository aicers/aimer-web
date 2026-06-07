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

function renderButton() {
  return render(
    <EventRegenerateButton
      locale="ko"
      customerId="c1"
      aiceId="aice-1"
      eventKey="1001"
      variant={VARIANT}
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
      "/api/customers/c1/aice/aice-1/events/1001/regenerate?lang=ENGLISH&model_name=openai&model=gpt-4o",
    );
    expect(init.method).toBe("POST");
    expect(init.headers["x-csrf-token"]).toBe("tok123");

    // Navigates to the new generation using the CURRENT locale (ko), not a
    // hardcoded `en`.
    expect(push).toHaveBeenCalledWith(
      "/ko/customers/c1/aice/aice-1/events/1001/analysis?lang=ENGLISH&model_name=openai&model=gpt-4o&generation=3",
    );
    expect(refresh).toHaveBeenCalled();
    expect(getByTestId("event-regenerate-status").textContent).toContain(
      "TR:regenerate.navigating",
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
