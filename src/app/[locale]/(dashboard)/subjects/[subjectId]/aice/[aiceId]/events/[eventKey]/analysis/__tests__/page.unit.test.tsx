// @vitest-environment jsdom
//
// T1 prerequisite (#395) — the event analysis page accepts a `generation`
// pin alongside the existing variant params and shows the "evidence
// version no longer available" notice when the loader reports the pinned
// row missing or superseded (no silent fallback to latest). Also covers
// the existing required-variant 404 guard and the invalid-generation 404.

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IocEnrichment } from "@/lib/analysis/ioc-evidence";
import type {
  EventCompareOutcome,
  ResultPageOutcome,
} from "@/lib/analysis/result-page-loader";

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

// The model catalog (#464) is a `server-only` module; stub it so importing
// the page in jsdom does not pull `server-only`. Two entries so the analyst
// compare selector (gated on `catalog.length > 1`) can render.
vi.mock("@/lib/analysis/model-catalog", () => ({
  getModelCatalog: () => [
    { modelName: "openai", model: "gpt-4o", label: "OpenAI GPT-4o" },
    { modelName: "anthropic", model: "claude-3-5", label: "Claude 3.5" },
  ],
}));

// Stub the compare client/view components with identifiable elements so the
// analyst-gate (#464) present/absent assertions are meaningful. The real
// selector is a client component pulling next/navigation hooks; re-export the
// shared param constants the page imports from the same module.
vi.mock("@/components/analysis/compare-model-selector", () => ({
  COMPARE_MODEL_NAME_PARAM: "compareModelName",
  COMPARE_MODEL_PARAM: "compareModel",
  CompareModelSelector: () => <div data-testid="compare-selector" />,
}));
vi.mock("@/components/analysis/event-compare-view", () => ({
  EventCompareView: () => <div data-testid="compare-view" />,
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
  usePathname: () => "/en/subjects/c1/aice/aice-1/events/1001/analysis",
}));

// `<Timestamp>` reads the active locale via `useLocale()`; this page test
// renders it outside a `NextIntlClientProvider`, so supply a fixed locale
// while keeping the rest of next-intl real (the server mock below still
// resolves the real `createTranslator`).
vi.mock("next-intl", async () => {
  const actual = await vi.importActual<typeof import("next-intl")>("next-intl");
  return { ...actual, useLocale: () => "en" };
});

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
      subjectId: CUSTOMER_ID,
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
    mockLoad.mockResolvedValueOnce({
      kind: "pin_unavailable",
      generation: 5,
      eventTitle: { eventTime: null, kind: null },
    });
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
    origin?: "manual" | "auto_baseline";
    requestedBy?: string | null;
    compare?: EventCompareOutcome;
    iocEnrichment?: IocEnrichment;
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
      eventTitle: {
        eventTime: new Date("2026-05-20T00:00:00Z"),
        kind: "HttpThreat",
      },
      severityScore: 0.42,
      likelihoodScore: 0.81,
      priorityTier: "HIGH",
      severityFactors: ["broad blast radius"],
      likelihoodFactors: ["lateral movement"],
      ttpTags: [{ id: "T1078", name: "Valid Accounts" }],
      cveRefs: [],
      cveStatus: null,
      iocEnrichment: viewer.iocEnrichment ?? { verdict: null, evidence: [] },
      analysisText: "narrative",
      origin: viewer.origin ?? "manual",
      requestedBy:
        viewer.requestedBy === undefined ? "acc-1" : viewer.requestedBy,
      requestedAt: new Date("2026-05-20T00:00:00Z"),
      isViewerAnalyst: viewer.isViewerAnalyst ?? false,
      canRegenerate: viewer.canRegenerate ?? false,
      sourceEventPresent: viewer.sourceEventPresent ?? true,
      parentStories: [],
      compare: viewer.compare,
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
    // aimer#480 (#474): the real snapshot / prompt-version values render,
    // not just their labels.
    expect(screen.getByText("2026-05-01")).toBeTruthy();
    expect(screen.getByText("v3")).toBeTruthy();
    expect(screen.getByTestId("event-regenerate-button")).toBeTruthy();
  });

  it("titles the subtitle `{event time} · {kind}` with aice_id as trailing meta (#559)", async () => {
    mockLoad.mockResolvedValueOnce(okOutcome({ isViewerAnalyst: true }));
    await renderPage(VARIANT);
    // The subtitle sits in the header beside the `AI Analysis` title.
    const header = screen.getByText("AI Analysis").parentElement;
    expect(header?.textContent).toContain("HTTP Threat"); // friendly kind
    expect(header?.textContent).toContain(AICE_ID); // provenance meta
    // The opaque `event_key` is never shown as a title.
    expect(header?.textContent).not.toContain(EVENT_KEY);
  });

  it("hides provenance + regenerate button for a non-analyst", async () => {
    mockLoad.mockResolvedValueOnce(
      okOutcome({ isViewerAnalyst: false, canRegenerate: false }),
    );
    await renderPage(VARIANT);
    // Analytically-meaningful fields stay visible.
    expect(screen.getByText("Language")).toBeTruthy();
    expect(screen.getByTestId("priority-tier-badge")).toBeTruthy();
    // Provenance is gone — labels and the underlying values.
    expect(screen.queryByText("Provider")).toBeNull();
    expect(screen.queryByText("Model snapshot")).toBeNull();
    expect(screen.queryByText("Requested by")).toBeNull();
    expect(screen.queryByText("2026-05-01")).toBeNull();
    expect(screen.queryByText("v3")).toBeNull();
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

  it("renders the system label and no retention banner for an auto-baseline result", async () => {
    // An auto-baseline leaf has `requestedBy=NULL` (no human requester) and
    // its backing `baseline_event` still exists, so the loader reports
    // `sourceEventPresent=true`. The page must show the localized "system"
    // label instead of an empty Requested-by field and must NOT raise the
    // retention banner (#493).
    mockLoad.mockResolvedValueOnce(
      okOutcome({
        isViewerAnalyst: true,
        canRegenerate: true,
        origin: "auto_baseline",
        requestedBy: null,
        sourceEventPresent: true,
      }),
    );
    await renderPage(VARIANT);
    expect(screen.getByText("Requested by")).toBeTruthy();
    expect(screen.getByText("system")).toBeTruthy();
    expect(screen.queryByTestId("retention-banner")).toBeNull();
  });
});

describe("AnalysisResultPage — model comparison (#464)", () => {
  it("threads the compare query params through to the loader", async () => {
    mockLoad.mockResolvedValueOnce(okOutcome({ isViewerAnalyst: true }));
    await renderPage({
      ...VARIANT,
      compareModelName: "anthropic",
      compareModel: "claude-3-5",
    });
    expect(lastArgs).toMatchObject({
      compare: { modelName: "anthropic", model: "claude-3-5" },
    });
  });

  it("shows the compare selector to an analyst even when canRegenerate is false", async () => {
    // A bridge-session analyst (isViewerAnalyst && !canRegenerate) can still
    // open a read-only 2-model comparison — the catalog is gated on
    // isViewerAnalyst, not the write gate (diverges from the story page).
    mockLoad.mockResolvedValueOnce(
      okOutcome({ isViewerAnalyst: true, canRegenerate: false }),
    );
    await renderPage(VARIANT);
    expect(screen.getByTestId("compare-selector")).toBeTruthy();
  });

  it("hides the compare selector from a non-analyst", async () => {
    mockLoad.mockResolvedValueOnce(okOutcome({ isViewerAnalyst: false }));
    await renderPage(VARIANT);
    expect(screen.queryByTestId("compare-selector")).toBeNull();
  });

  it("renders the compare view when the loader returns a compare outcome", async () => {
    mockLoad.mockResolvedValueOnce(
      okOutcome({
        isViewerAnalyst: true,
        compare: { kind: "not_generated", modelName: "anthropic", model: "x" },
      }),
    );
    await renderPage(VARIANT);
    expect(screen.getByTestId("compare-view")).toBeTruthy();
    // The single-column analysis section is replaced by the compare view.
    expect(screen.queryByTestId("analysis-body")).toBeNull();
  });

  it("renders the single-column analysis (no compare view) when no compare is requested", async () => {
    mockLoad.mockResolvedValueOnce(okOutcome({ isViewerAnalyst: true }));
    await renderPage(VARIANT);
    expect(screen.queryByTestId("compare-view")).toBeNull();
    expect(screen.getByTestId("analysis-body")).toBeTruthy();
  });
});
