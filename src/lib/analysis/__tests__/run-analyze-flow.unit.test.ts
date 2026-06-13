// Bilingual invariant on the manual / synchronous analyze path (#581).
//
// `runAnalyzeFlow` must NEVER natively generate a non-English row: a
// non-English request produces/reuses the English canonical (native
// `analyzeEvent`) and derives the user-language row by translating it. These
// tests lock in the orchestration that is unique to this path and not covered
// by the lower-level `deriveEventTranslation` / regenerate tests:
//   - non-English request, no canonical yet -> native English + derive
//   - non-English request, canonical already present + !force -> NO native
//     English call, derive only (retry-only-translation semantics)
//   - canonical succeeds but the translation fails -> request fails (partial)
//     while the canonical is kept; a retry then runs only the translation
//   - English target + !force -> native only, never derives a translation
//   - English target + force -> re-generates the canonical AND re-derives the
//     configured user language (force-regenerate consistency: a Korean row
//     from the prior generation must not stay pinned to the superseded one)
//   - an existing user-language row + !force is a cache hit (no native,
//     no derive)
//
// The heavy I/O is faked the same way `analyze-and-store-event.unit.test.ts`
// does: a fake customer pool, real `@/lib/redaction` (only the DB-backed
// range/domain loaders stubbed), the aimer `analyzeEvent` call mocked, and the
// existing `detection_events` row short-circuiting redaction. The native
// English `analyzeEvent` call count is the observable for "did it generate
// natively", and `deriveEventTranslation` is mocked to observe derivation.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/audit", () => ({ auditLog: vi.fn() }));

// Native English generation (`analyzeEvent`) issued inside
// `analyzeAndStoreEventResult`. Counting its calls tells us whether the path
// generated natively or skipped to a pure translation.
const mockGraphqlRequest = vi.fn();
vi.mock("@/lib/graphql/client", () => ({
  graphqlRequest: (...args: unknown[]) => mockGraphqlRequest(...args),
}));

// User-language derivation — the translation seam.
const mockDeriveTranslation = vi.fn();
vi.mock("../translate-event-analysis", () => ({
  deriveEventTranslation: (...args: unknown[]) =>
    mockDeriveTranslation(...args),
}));

vi.mock("@/lib/auth/authorization", () => ({
  authorize: vi.fn(async () => ({ authorized: true })),
}));

// `withTransaction` runs the callback against a fixed client; `getAuthPool`
// yields the fake auth pool. The auth-side transaction only feeds the mocked
// `authorize`, so the client it passes is irrelevant there.
let dbClient: ReturnType<typeof makeDbClient>;
vi.mock("@/lib/db/client", () => ({
  getAuthPool: () => authPool,
  withTransaction: async (_pool: unknown, cb: (c: unknown) => unknown) =>
    cb(dbClient),
}));

let customerPool: { query: ReturnType<typeof vi.fn>; connect: () => unknown };
vi.mock("@/lib/db/customer-runtime-pool", () => ({
  getCustomerRuntimePool: () => customerPool,
}));

// Keep the real redaction engine (scanHallucinations / redact / readMapWithLock
// run for real), but stub the two DB-backed loaders so no auth-DB query is
// needed.
vi.mock("@/lib/redaction", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/redaction")>();
  return {
    ...actual,
    loadCustomerRanges: vi.fn(async () => actual.buildRangeSet([])),
    loadCustomerOwnedDomains: vi.fn(async () => actual.EMPTY_OWNED_DOMAIN_SET),
  };
});

import type { RunAnalyzeFlowParams } from "../run-analyze-flow";
import { DEFAULT_LANG, runAnalyzeFlow } from "../run-analyze-flow";

const CUSTOMER_ID = "00000000-0000-0000-0000-000000000001";
const AICE_ID = "aice-1";
const EVENT_KEY = "1001";
const EVENT_TIME = "2026-05-20T00:00:00Z";
const ACCOUNT = "00000000-0000-0000-0000-0000000000aa";

// Test-controlled state for the two top-level event_analysis_result reads.
// Cache rows carry `restoration_lang` so the mock can apply the real cache
// predicate: a non-English hit REQUIRES restoration_lang = ENGLISH (a genuine
// translation); an English hit REQUIRES restoration_lang IS NULL (native
// canonical). A legacy / native non-English row (restoration_lang null) is
// therefore NOT a cache hit.
let cacheRows: { requested_at: Date; restoration_lang: string | null }[];
let canonicalRows: unknown[]; // liveCanonicalExists (English canonical)

function makeDbClient() {
  return {
    query: vi.fn(async (sql: string) => {
      if (sql.includes("next_generation")) {
        return { rows: [{ next_generation: 4 }] };
      }
      // ingestAndRedact: an existing detection_events row short-circuits
      // redaction (no redact()/writeMap), and carries the event_time the
      // analyze flow recovers for aimer.
      if (sql.includes("FROM detection_events")) {
        return {
          rows: [{ redacted_event: { event_time: EVENT_TIME, foo: "bar" } }],
        };
      }
      return { rows: [] };
    }),
    release: vi.fn(),
  };
}

const authPool = {
  query: vi.fn(async (sql: string) => {
    if (sql.includes("FROM customers")) {
      return {
        rows: [
          { id: CUSTOMER_ID, database_status: "active", status: "active" },
        ],
      };
    }
    return { rows: [] };
  }),
};

function topLevelQuery(sql: string, params?: unknown[]) {
  // Non-forced result-cache lookup (joins detection_events via EXISTS).
  if (sql.includes("EXISTS") && sql.includes("detection_events d")) {
    // Mirror the real cache predicate: $3 = langForStorage, $6 = DEFAULT_LANG.
    const lang = params?.[2];
    const defLang = params?.[5];
    const rows = cacheRows.filter((r) =>
      lang === defLang
        ? r.restoration_lang == null
        : r.restoration_lang === defLang,
    );
    return { rows };
  }
  // liveCanonicalExists.
  if (sql.includes("SELECT 1 AS one")) {
    return { rows: canonicalRows };
  }
  return { rows: [] };
}

function baseParams(
  overrides: Partial<RunAnalyzeFlowParams> = {},
): RunAnalyzeFlowParams {
  return {
    customer: { kind: "id", customerId: CUSTOMER_ID },
    aiceId: AICE_ID,
    eventKey: EVENT_KEY,
    eventData: {
      event_key: EVENT_KEY,
      event_time: EVENT_TIME,
      schema_version: "1.0",
    },
    lang: "KOREAN",
    modelName: "anthropic",
    model: "claude-x",
    force: false,
    accountId: ACCOUNT,
    sessionId: "sess-1",
    ipAddress: "127.0.0.1",
    bridgeScope: null,
    origin: "manual",
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  cacheRows = [];
  canonicalRows = [];
  dbClient = makeDbClient();
  customerPool = {
    query: vi.fn(async (sql: string, params?: unknown[]) =>
      topLevelQuery(sql, params),
    ),
    connect: vi.fn(async () => dbClient),
  };
  mockGraphqlRequest.mockResolvedValue({
    analyzeEvent: {
      severityScore: 0.4,
      likelihoodScore: 0.8,
      severityFactors: ["broad blast radius"],
      likelihoodFactors: ["lateral movement"],
      ttpTags: [],
      analysis: "plain narrative with no entities",
      promptVersion: "v7",
      modelActualVersion: "claude-x-2026-05-01",
    },
  });
  mockDeriveTranslation.mockResolvedValue({
    kind: "translated",
    generation: 4,
  });
});

describe("runAnalyzeFlow bilingual invariant (#581)", () => {
  it("non-English with no canonical: generates English natively, then derives the translation", async () => {
    const res = await runAnalyzeFlow(baseParams());
    expect(res.kind).toBe("success");
    // Exactly one native generation, and it is the ENGLISH canonical.
    expect(mockGraphqlRequest).toHaveBeenCalledTimes(1);
    expect(mockDeriveTranslation).toHaveBeenCalledTimes(1);
    expect(mockDeriveTranslation).toHaveBeenCalledWith(
      expect.objectContaining({
        targetLang: "KOREAN",
        modelName: "anthropic",
        model: "claude-x",
      }),
    );
  });

  it("non-English with the canonical already present (not forced): derives only, NO native English call", async () => {
    canonicalRows = [{ one: 1 }]; // English canonical exists
    const res = await runAnalyzeFlow(baseParams());
    expect(res.kind).toBe("success");
    // Retry-only-translation: the native English generation is skipped.
    expect(mockGraphqlRequest).not.toHaveBeenCalled();
    expect(mockDeriveTranslation).toHaveBeenCalledTimes(1);
  });

  it("force regenerates the English canonical even when one exists, then re-derives", async () => {
    canonicalRows = [{ one: 1 }];
    const res = await runAnalyzeFlow(baseParams({ force: true }));
    expect(res.kind).toBe("success");
    expect(mockGraphqlRequest).toHaveBeenCalledTimes(1); // English re-generated
    expect(mockDeriveTranslation).toHaveBeenCalledTimes(1);
  });

  it("canonical success + translation failure: request fails, canonical kept", async () => {
    mockDeriveTranslation.mockResolvedValue({
      kind: "error",
      errorCode: "aimer_unavailable",
      message: "translate call failed",
    });
    const res = await runAnalyzeFlow(baseParams());
    expect(res.kind).toBe("error");
    if (res.kind === "error") expect(res.errorCode).toBe("aimer_unavailable");
    // The English canonical was still generated (and persisted) — only the
    // translation failed, so a retry re-derives without re-generating English.
    expect(mockGraphqlRequest).toHaveBeenCalledTimes(1);
  });

  it("translation leak/shape failure surfaces as a terminal invalid-request error", async () => {
    mockDeriveTranslation.mockResolvedValue({
      kind: "leak",
      field: "analysis",
      message: "redaction-token leak in translated analysis",
    });
    const res = await runAnalyzeFlow(baseParams());
    expect(res.kind).toBe("error");
    if (res.kind === "error")
      expect(res.errorCode).toBe("aimer_invalid_request");
  });

  it("English target (not forced): generates natively and NEVER derives a translation", async () => {
    const res = await runAnalyzeFlow(baseParams({ lang: "ENGLISH" }));
    expect(res.kind).toBe("success");
    expect(mockGraphqlRequest).toHaveBeenCalledTimes(1);
    expect(mockDeriveTranslation).not.toHaveBeenCalled();
  });

  it("English target (forced): re-generates the canonical AND re-derives the user language", async () => {
    // Force-regenerating the English canonical advances its generation, so the
    // configured user-language row (KOREAN here — the test env's DEFAULT_LOCALE
    // is unset -> "ko") must be re-derived at the new generation rather than
    // left pinned to the superseded canonical (#581 review R1).
    canonicalRows = [{ one: 1 }]; // a prior canonical exists
    const res = await runAnalyzeFlow(
      baseParams({ lang: "ENGLISH", force: true }),
    );
    expect(res.kind).toBe("success");
    // The English canonical is re-generated natively...
    expect(mockGraphqlRequest).toHaveBeenCalledTimes(1);
    // ...and the user-language translation is re-derived from it.
    expect(mockDeriveTranslation).toHaveBeenCalledTimes(1);
    expect(mockDeriveTranslation).toHaveBeenCalledWith(
      expect.objectContaining({ targetLang: "KOREAN" }),
    );
  });

  it("existing TRANSLATED user-language row (not forced) is a cache hit: no native call, no derive", async () => {
    // A genuine translation (restoration_lang = ENGLISH) of a canonical.
    cacheRows = [
      { requested_at: new Date(EVENT_TIME), restoration_lang: DEFAULT_LANG },
    ];
    const res = await runAnalyzeFlow(baseParams());
    expect(res.kind).toBe("success");
    if (res.kind === "success") expect(res.cached).toBe(true);
    expect(mockGraphqlRequest).not.toHaveBeenCalled();
    expect(mockDeriveTranslation).not.toHaveBeenCalled();
  });

  it("legacy NATIVE non-English row (not forced) is NOT a cache hit: generates the canonical and derives", async () => {
    // #581 review R5: a pre-#581 sync request could leave a native Korean row
    // (restoration_lang IS NULL) with NO English canonical — the exact
    // pre-existing state the issue calls out. It must NOT be treated as a valid
    // cache hit; the request falls through to generate the English canonical
    // and derive a proper translation that supersedes/replaces the legacy row.
    cacheRows = [
      { requested_at: new Date(EVENT_TIME), restoration_lang: null },
    ];
    canonicalRows = []; // no English canonical yet
    const res = await runAnalyzeFlow(baseParams());
    expect(res.kind).toBe("success");
    if (res.kind === "success") expect(res.cached).toBe(false);
    // The English canonical is generated natively...
    expect(mockGraphqlRequest).toHaveBeenCalledTimes(1);
    // ...and the user-language translation is derived (replacing the legacy row).
    expect(mockDeriveTranslation).toHaveBeenCalledTimes(1);
    expect(mockDeriveTranslation).toHaveBeenCalledWith(
      expect.objectContaining({ targetLang: "KOREAN" }),
    );
  });
});
