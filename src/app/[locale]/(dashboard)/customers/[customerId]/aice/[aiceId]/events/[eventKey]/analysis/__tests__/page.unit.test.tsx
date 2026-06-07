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

// The page also loads the reverse "Cited by" trail (T2 #396) on the ok
// path; stub it (and avoid pulling its `server-only` import into jsdom).
vi.mock("@/lib/analysis/cited-by-loader", () => ({
  loadCitedByReports: async () => [],
}));

// Render an identifiable element (not `null`) so present/absent assertions
// on the analyst / canRegenerate gate (#463) are meaningful. The real
// button is a client component pulling next-intl + next/navigation.
vi.mock("../regenerate-button", () => ({
  EventRegenerateButton: () => (
    <button type="button" data-testid="event-regenerate-button" />
  ),
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

vi.mock("next-intl/server", async () => {
  const { createTranslator } = await import("next-intl");
  const messages = (await import("@/i18n/messages/en.json")).default;
  return {
    getTranslations: async (namespace?: string) =>
      createTranslator({
        locale: "en",
        messages,
        namespace: namespace as never,
      }),
  };
});

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
    expect(screen.getByTestId("pin-unavailable-banner")).toBeTruthy();
    expect(screen.getByTestId("pin-unavailable-banner").textContent).toContain(
      "no longer available",
    );
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

function okOutcome(
  viewer: {
    isViewerAnalyst?: boolean;
    canRegenerate?: boolean;
    sourceEventPresent?: boolean;
  } = {},
): ResultPageOutcome {
  return {
    kind: "ok",
    data: {
      customerId: CUSTOMER_ID,
      aiceId: AICE_ID,
      eventKey: EVENT_KEY,
      lang: "ENGLISH",
      modelName: "openai",
      model: "gpt-4o",
      generation: 1,
      modelActualVersion: "2026-05-01",
      promptVersion: "v3",
      severityScore: 0.42,
      likelihoodScore: 0.81,
      priorityTier: "HIGH",
      severityFactors: ["broad blast radius"],
      likelihoodFactors: ["lateral movement"],
      ttpTags: [{ id: "T1078", name: "Valid Accounts" }],
      analysisText: "narrative",
      requestedBy: "acc-1",
      requestedAt: new Date("2026-05-20T00:00:00Z"),
      isViewerAnalyst: viewer.isViewerAnalyst ?? false,
      canRegenerate: viewer.canRegenerate ?? false,
      sourceEventPresent: viewer.sourceEventPresent ?? true,
      parentStories: [],
    },
  };
}

describe("AnalysisResultPage — analyst gating + in-app regenerate (#463)", () => {
  it("shows provenance + regenerate button for an analyst (no bridge)", async () => {
    mockLoad.mockResolvedValueOnce(
      okOutcome({ isViewerAnalyst: true, canRegenerate: true }),
    );
    await renderPage(VARIANT);
    // Provenance fields are analyst-only.
    expect(screen.getByText("Provider")).toBeTruthy();
    expect(screen.getByText("Model snapshot")).toBeTruthy();
    expect(screen.getByText("Requested by")).toBeTruthy();
    expect(screen.getByTestId("event-regenerate-button")).toBeTruthy();
  });

  it("hides provenance + regenerate button for a non-analyst", async () => {
    mockLoad.mockResolvedValueOnce(
      okOutcome({ isViewerAnalyst: false, canRegenerate: false }),
    );
    await renderPage(VARIANT);
    // Analytically-meaningful fields stay visible.
    expect(screen.getByText("Language")).toBeTruthy();
    expect(screen.getByTestId("priority-tier-badge")).toBeTruthy();
    // Provenance is gone.
    expect(screen.queryByText("Provider")).toBeNull();
    expect(screen.queryByText("Model snapshot")).toBeNull();
    expect(screen.queryByText("Requested by")).toBeNull();
    expect(screen.queryByTestId("event-regenerate-button")).toBeNull();
  });

  it("hides the regenerate button for a bridge-session analyst (canRegenerate false)", async () => {
    // A bridge-session analyst can read provenance, but the regenerate
    // endpoint authorizes a write a bridge session can never pass — so the
    // button is hidden to avoid a click that would 403.
    mockLoad.mockResolvedValueOnce(
      okOutcome({ isViewerAnalyst: true, canRegenerate: false }),
    );
    await renderPage(VARIANT);
    expect(screen.getByText("Provider")).toBeTruthy();
    expect(screen.queryByTestId("event-regenerate-button")).toBeNull();
    // Force re-run shares the sourceEventPresent gate and is still shown.
    expect(screen.getByTestId("force-rerun-link")).toBeTruthy();
  });

  it("hides both re-run paths when the source event was swept by retention", async () => {
    mockLoad.mockResolvedValueOnce(
      okOutcome({
        isViewerAnalyst: true,
        canRegenerate: true,
        sourceEventPresent: false,
      }),
    );
    await renderPage(VARIANT);
    expect(screen.queryByTestId("event-regenerate-button")).toBeNull();
    expect(screen.queryByTestId("force-rerun-link")).toBeNull();
    expect(screen.getByTestId("retention-banner")).toBeTruthy();
  });
});
