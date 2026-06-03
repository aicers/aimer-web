// @vitest-environment jsdom
//
// T1 prerequisite (#395) — the event analysis page accepts a `generation`
// pin alongside the existing variant params and shows the "evidence
// version no longer available" notice when the loader reports the pinned
// row missing or superseded (no silent fallback to latest). Also covers
// the existing required-variant 404 guard and the invalid-generation 404.

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ResultPageOutcome } from "@/lib/analysis/result-page-loader";

const mockLoad = vi.fn<() => Promise<ResultPageOutcome>>();

vi.mock("@/lib/analysis/result-page-loader", () => ({
  loadAnalysisResultPage: (...args: unknown[]) => {
    lastArgs = args[0];
    return mockLoad();
  },
}));

// biome-ignore lint/suspicious/noExplicitAny: captured loader input
let lastArgs: any;

vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
  // Read by the breadcrumb label registrar mounted on the ok path.
  usePathname: () => "/en/customers/c1/aice/aice-1/events/1001/analysis",
}));

vi.mock("next-intl/server", () => ({
  getTranslations: async () => (key: string) => key,
}));

import AnalysisResultPage from "../page";

const CUSTOMER_ID = "c0000000-0000-0000-0000-000000000001";
const AICE_ID = "aice-1";
const EVENT_KEY = "1001";

const VARIANT = { lang: "ENGLISH", model_name: "openai", model: "gpt-4o" };

async function renderPage(searchParams: Record<string, string>): Promise<void> {
  const jsx = await AnalysisResultPage({
    params: Promise.resolve({
      locale: "en",
      customerId: CUSTOMER_ID,
      aiceId: AICE_ID,
      eventKey: EVENT_KEY,
    }),
    searchParams: Promise.resolve(searchParams),
  });
  render(jsx);
}

beforeEach(() => {
  mockLoad.mockReset();
  lastArgs = undefined;
});
afterEach(() => cleanup());

describe("AnalysisResultPage — generation pin", () => {
  it("threads a valid generation pin through to the loader", async () => {
    mockLoad.mockResolvedValueOnce({ kind: "not_found" });
    await expect(renderPage({ ...VARIANT, generation: "5" })).rejects.toThrow(
      "NEXT_NOT_FOUND",
    );
    expect(lastArgs).toMatchObject({
      aiceId: AICE_ID,
      eventKey: EVENT_KEY,
      lang: "ENGLISH",
      modelName: "openai",
      model: "gpt-4o",
      generation: 5,
    });
  });

  it("shows the evidence-unavailable notice for a pin_unavailable outcome", async () => {
    mockLoad.mockResolvedValueOnce({ kind: "pin_unavailable", generation: 5 });
    await renderPage({ ...VARIANT, generation: "5" });
    expect(screen.getByLabelText("pin-unavailable-banner")).toBeTruthy();
    expect(
      screen.getByLabelText("pin-unavailable-banner").textContent,
    ).toContain("no longer available");
  });

  it("404s a present-but-invalid generation rather than resolving latest", async () => {
    await expect(renderPage({ ...VARIANT, generation: "-1" })).rejects.toThrow(
      "NEXT_NOT_FOUND",
    );
    expect(mockLoad).not.toHaveBeenCalled();
  });

  it("404s when a required variant param is missing", async () => {
    await expect(
      renderPage({ lang: "ENGLISH", generation: "5" }),
    ).rejects.toThrow("NEXT_NOT_FOUND");
    expect(mockLoad).not.toHaveBeenCalled();
  });
});
