import { ClientError } from "graphql-request";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mocks — these match the route's import surface. The structure mirrors
// `src/app/api/events/__tests__/ingest.unit.test.ts` so future maintainers
// keep one mental model for "how route units are tested".
// ---------------------------------------------------------------------------

vi.mock("server-only", () => ({}));

const mockAuditLog = vi.fn(async () => {});
vi.mock("@/lib/audit", () => ({ auditLog: mockAuditLog }));

const mockAuthorize = vi.fn();
vi.mock("@/lib/auth/authorization", () => ({
  authorize: (...args: unknown[]) => mockAuthorize(...args),
}));

const mockGetCustomerByExternalKey = vi.fn();
vi.mock("@/lib/auth/customers", () => ({
  getCustomerByExternalKey: (...args: unknown[]) =>
    mockGetCustomerByExternalKey(...args),
}));

vi.mock("@/lib/auth/guards", async () => {
  return {
    // biome-ignore lint/complexity/noBannedTypes: test mock callable
    withAuth: (handler: Function) => (req: NextRequest) =>
      handler(req, {
        accountId: "acc-1",
        sessionId: "sess-1",
        authContext: "general",
        tokenVersion: 1,
        iat: 1000,
        meta: { ipAddress: "127.0.0.1", userAgent: "test", origin: null },
        bridgeAiceId: null,
        bridgeCustomerIds: null,
        audit: {},
      }),
    verifyOrigin: () => null,
    verifyCsrf: () => null,
  };
});

// Pool / withTransaction stubs. We capture all queries on a per-test
// queue so each test scenario plays exactly the rows it needs.
interface QueryStub {
  match: (sql: string) => boolean;
  rows?: Record<string, unknown>[];
  rowCount?: number;
  throws?: Error;
}

let queryQueue: QueryStub[] = [];

function pushStub(stub: QueryStub) {
  queryQueue.push(stub);
}

function makePool() {
  return {
    query: vi.fn(async (sql: string) => {
      // Find the first matching stub (FIFO per matcher predicate).
      const idx = queryQueue.findIndex((s) => s.match(sql));
      if (idx === -1) {
        // Default: empty result. Keeps tests focused on the queries
        // they care about without forcing them to enumerate every
        // pool.query call (advisory locks, etc.).
        return { rows: [], rowCount: 0 };
      }
      const [stub] = queryQueue.splice(idx, 1);
      if (stub.throws) throw stub.throws;
      return { rows: stub.rows ?? [], rowCount: stub.rowCount ?? 0 };
    }),
    connect: vi.fn(async () => {
      const client = {
        query: vi.fn(async (sql: string) => {
          const idx = queryQueue.findIndex((s) => s.match(sql));
          if (idx === -1) return { rows: [], rowCount: 0 };
          const [stub] = queryQueue.splice(idx, 1);
          if (stub.throws) throw stub.throws;
          return { rows: stub.rows ?? [], rowCount: stub.rowCount ?? 0 };
        }),
        release: vi.fn(),
      };
      return client;
    }),
  };
}

const authPool = makePool();
const customerPool = makePool();

vi.mock("@/lib/db/client", () => ({
  getAuthPool: () => authPool,
  withTransaction: async (
    pool: { connect: () => Promise<{ query: unknown; release: () => void }> },
    fn: (client: unknown) => unknown,
  ) => {
    // Route the transaction through the underlying pool's `connect()`
    // so queries inside the transaction consult the same `queryQueue`
    // tests use to stub data. Without this, every client-side query
    // (synthetic ingest, SELECT detection_events, writeMap) would
    // bypass test stubs and return empty results.
    const client = await pool.connect();
    try {
      return await fn(client);
    } finally {
      client.release();
    }
  },
}));

vi.mock("@/lib/db/customer-runtime-pool", () => ({
  getCustomerRuntimePool: () => customerPool,
}));

// Untyped vi.fn() instances — typing them with a concrete async return
// type narrows the inferred call signature, which then trips
// `spread argument must have a tuple type` when forwarded through the
// `(...args) => mock(...args)` wrapper Vitest expects.
const mockLoadCustomerRanges = vi.fn();
const mockReadMapWithLock = vi.fn();
const mockWriteMap = vi.fn();
const mockRedact = vi.fn();
const mockScanHallucinations = vi.fn();

vi.mock("@/lib/redaction", () => ({
  loadCustomerRanges: mockLoadCustomerRanges,
  readMapWithLock: mockReadMapWithLock,
  writeMap: mockWriteMap,
  redact: mockRedact,
  scanHallucinations: mockScanHallucinations,
  ENGINE_VERSION: "1.0.0",
}));

const mockGraphqlRequest = vi.fn();
vi.mock("@/lib/graphql/client", () => ({
  graphqlRequest: (...args: unknown[]) => mockGraphqlRequest(...args),
}));

vi.mock("@/lib/graphql/__generated__/analyze-event", () => ({
  AnalyzeEventDocument: { kind: "Document" },
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const CUSTOMER_ID = "a0000000-0000-0000-0000-000000000001";
const EXTERNAL_KEY = "ext-key-1";
const AICE_ID = "aice-1";
const EVENT_KEY = "1001";

function makeRequest(body: Record<string, unknown>): NextRequest {
  return new NextRequest("http://localhost:3000/api/analysis/analyze", {
    method: "POST",
    body: JSON.stringify(body),
    headers: {
      "content-type": "application/json",
      origin: "http://localhost:3000",
    },
  });
}

function defaultBody(overrides: Record<string, unknown> = {}) {
  return {
    event_data: { event_key: EVENT_KEY, hello: "world" },
    event_key: EVENT_KEY,
    customer_id: CUSTOMER_ID,
    aice_id: AICE_ID,
    lang: "ENGLISH",
    model_name: "openai",
    model: "gpt-4o",
    force: false,
    ...overrides,
  };
}

async function callPOST(req: NextRequest) {
  const { POST } = await import("../analyze/route");
  return POST(req);
}

function stubActiveCustomerLookup() {
  pushStub({
    match: (s) => /FROM customers WHERE id = \$1/.test(s),
    rows: [{ id: CUSTOMER_ID, database_status: "active", status: "active" }],
  });
}

function stubCacheMiss() {
  pushStub({
    match: (s) => s.includes("FROM event_analysis_result"),
    rows: [],
  });
}

function stubInsertDetectionEvent({ rowCount = 1 } = {}) {
  pushStub({
    match: (s) => /INSERT INTO detection_events/.test(s),
    rowCount,
  });
}

function stubInsertAnalysisResult() {
  pushStub({
    match: (s) => /INSERT INTO event_analysis_result/.test(s),
    rowCount: 1,
  });
}

beforeEach(() => {
  vi.resetModules();
  queryQueue = [];
  mockAuditLog.mockClear();
  mockAuthorize.mockReset().mockResolvedValue({ authorized: true });
  mockGetCustomerByExternalKey.mockReset();
  mockLoadCustomerRanges
    .mockReset()
    .mockResolvedValue({ normalisedCidrs: [], ranges: [] });
  mockReadMapWithLock.mockReset().mockResolvedValue(null);
  mockWriteMap.mockReset().mockResolvedValue(undefined);
  mockRedact.mockReset().mockReturnValue({
    redacted: { event_key: EVENT_KEY, hello: "world" },
    mergedMap: {},
    policyVersion: "engine:1.0.0|ranges:empty",
    mapChanged: false,
  });
  mockScanHallucinations.mockReset().mockReturnValue({
    scanned: "analysis text",
    counts: { ip: 0, email: 0, mac: 0 },
  });
  mockGraphqlRequest.mockReset().mockResolvedValue({
    analyzeEvent: { threatScore: 0.42, analysis: "analysis text" },
  });
  authPool.query.mockClear();
  authPool.connect.mockClear();
  customerPool.query.mockClear();
  customerPool.connect.mockClear();
});

// ---------------------------------------------------------------------------
// Behaviour matrix (5 RFC 0001 cases)
// ---------------------------------------------------------------------------

describe("POST /api/analysis/analyze — behaviour matrix", () => {
  it("event missing → redact + ingest + analyze + store (force=false)", async () => {
    stubActiveCustomerLookup();
    stubCacheMiss();
    stubInsertDetectionEvent();
    stubInsertAnalysisResult();

    const res = await callPOST(makeRequest(defaultBody()));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ view_url: expect.any(String), cached: false });

    expect(mockReadMapWithLock).toHaveBeenCalledOnce();
    expect(mockWriteMap).toHaveBeenCalledOnce();
    expect(mockGraphqlRequest).toHaveBeenCalledOnce();
    expect(mockAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: "ai_analysis.request_issued" }),
    );
    expect(mockAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: "ai_analysis.result_stored" }),
    );
  });

  it("event exists, result missing → analyze stored event + store", async () => {
    stubActiveCustomerLookup();
    stubCacheMiss();
    // The existing detection_events row carries a DIFFERENT redacted
    // payload than the caller's request — this is the cache-poisoning
    // surface RFC 0001 explicitly defends against. The aimer call must
    // use the STORED `redacted_event`, not the request body.
    const storedRedacted = { event_key: EVENT_KEY, stored: "in-db" };
    pushStub({
      match: (s) =>
        /SELECT redacted_event FROM detection_events/.test(s) &&
        /WHERE aice_id = \$1/.test(s),
      rows: [{ redacted_event: storedRedacted }],
    });
    stubInsertAnalysisResult();

    const res = await callPOST(makeRequest(defaultBody()));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.cached).toBe(false);
    expect(mockGraphqlRequest).toHaveBeenCalledOnce();
    // The aimer call MUST receive the stored redacted_event, NOT the
    // freshly redacted request body.
    expect(mockGraphqlRequest).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ eventData: storedRedacted }),
      expect.anything(),
    );
  });

  it("force=true + event exists → analyze stored event (does not re-redact request body)", async () => {
    stubActiveCustomerLookup();
    // No cache lookup — force=true.
    const storedRedacted = { event_key: EVENT_KEY, stored: "in-db" };
    pushStub({
      match: (s) =>
        /SELECT redacted_event FROM detection_events/.test(s) &&
        /WHERE aice_id = \$1/.test(s),
      rows: [{ redacted_event: storedRedacted }],
    });
    stubInsertAnalysisResult();

    // Caller supplies a wildly different `event_data` payload — the
    // route must ignore it and send the stored `redacted_event`.
    const res = await callPOST(
      makeRequest(
        defaultBody({
          force: true,
          event_data: { event_key: EVENT_KEY, attacker_supplied: true },
        }),
      ),
    );
    expect(res.status).toBe(200);
    expect(mockGraphqlRequest).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ eventData: storedRedacted }),
      expect.anything(),
    );
  });

  it("event exists + result exists + force=false → cache hit, no aimer call", async () => {
    stubActiveCustomerLookup();
    pushStub({
      match: (s) => s.includes("FROM event_analysis_result"),
      rows: [{ requested_at: new Date() }],
    });

    const res = await callPOST(makeRequest(defaultBody()));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ view_url: expect.any(String), cached: true });
    expect(mockGraphqlRequest).not.toHaveBeenCalled();
    expect(mockAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "ai_analysis.request_issued",
        details: expect.objectContaining({ cached: true }),
      }),
    );
  });

  it("force=true skips the cache lookup", async () => {
    stubActiveCustomerLookup();
    // No cache lookup stub — force=true must not query event_analysis_result
    // for the cache-hit path. We still need INSERTs.
    stubInsertDetectionEvent();
    stubInsertAnalysisResult();

    const res = await callPOST(makeRequest(defaultBody({ force: true })));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.cached).toBe(false);
    expect(mockGraphqlRequest).toHaveBeenCalledOnce();
    expect(mockAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "ai_analysis.request_issued",
        details: expect.objectContaining({ force: true, cached: false }),
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

describe("POST /api/analysis/analyze — validation", () => {
  it("returns event_key_mismatch when event_data.event_key disagrees with event_key", async () => {
    const res = await callPOST(
      makeRequest(
        defaultBody({
          event_data: { event_key: "9999", hello: "world" },
          event_key: EVENT_KEY,
        }),
      ),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("event_key_mismatch");
    expect(body.error.retryable).toBe(false);
  });

  it("rejects non-canonical event_key form '01' at the Zod layer", async () => {
    const res = await callPOST(
      makeRequest(
        defaultBody({ event_key: "01", event_data: { event_key: "01" } }),
      ),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("invalid_event_data");
  });

  it("rejects supplying BOTH customer_id and external_key", async () => {
    const res = await callPOST(
      makeRequest(defaultBody({ external_key: EXTERNAL_KEY })),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("invalid_event_data");
  });

  it("returns lang_unsupported for a syntactically valid but unsupported lang value", async () => {
    // The Zod layer accepts `lang` as a free-form string so the
    // dedicated `lang_unsupported` error code remains reachable per
    // RFC 0001's 12-code error table. An unsupported value must NOT
    // collapse into the generic `invalid_event_data`.
    const res = await callPOST(makeRequest(defaultBody({ lang: "FRENCH" })));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("lang_unsupported");
    expect(body.error.retryable).toBe(false);
  });

  it("returns event_data_too_large when payload exceeds the configured cap", async () => {
    const originalEnv = process.env.BRIDGE_MAX_PAYLOAD_BYTES;
    process.env.BRIDGE_MAX_PAYLOAD_BYTES = "10";
    try {
      const res = await callPOST(makeRequest(defaultBody()));
      expect(res.status).toBe(413);
      const body = await res.json();
      expect(body.error.code).toBe("event_data_too_large");
    } finally {
      if (originalEnv === undefined)
        delete process.env.BRIDGE_MAX_PAYLOAD_BYTES;
      else process.env.BRIDGE_MAX_PAYLOAD_BYTES = originalEnv;
    }
  });
});

// ---------------------------------------------------------------------------
// Customer identifier + status gates
// ---------------------------------------------------------------------------

describe("POST /api/analysis/analyze — customer resolution", () => {
  it("external_key path resolves and reaches the same downstream behaviour", async () => {
    mockGetCustomerByExternalKey.mockResolvedValue({
      id: CUSTOMER_ID,
      externalKey: EXTERNAL_KEY,
      name: "c1",
      description: null,
      status: "active",
      databaseStatus: "active",
      wrappedDek: null,
    });
    stubCacheMiss();
    stubInsertDetectionEvent();
    stubInsertAnalysisResult();

    const body = defaultBody({ external_key: EXTERNAL_KEY });
    delete (body as Record<string, unknown>).customer_id;
    const res = await callPOST(makeRequest(body));
    expect(res.status).toBe(200);
    expect(mockAuthorize).toHaveBeenCalledWith(
      expect.anything(),
      "general",
      "acc-1",
      "analyses:create",
      expect.objectContaining({ customerId: CUSTOMER_ID }),
    );
  });

  it("external_key probing returns authorization_failed (not a distinct 404)", async () => {
    mockGetCustomerByExternalKey.mockResolvedValue(null);
    const body = defaultBody({ external_key: "ghost" });
    delete (body as Record<string, unknown>).customer_id;
    const res = await callPOST(makeRequest(body));
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.error.code).toBe("authorization_failed");
  });

  it("database_status=provisioning is rejected after authorize but before the customer DB pool", async () => {
    pushStub({
      match: (s) => /FROM customers WHERE id = \$1/.test(s),
      rows: [
        { id: CUSTOMER_ID, database_status: "provisioning", status: "active" },
      ],
    });
    const res = await callPOST(makeRequest(defaultBody()));
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.code).toBe("authorization_failed");
    // authorize() runs first so the externally observable behaviour is
    // identical to a denied authorization. Reaching the
    // `database_status` gate requires already clearing `authorize()`.
    expect(mockAuthorize).toHaveBeenCalledOnce();
    // The customer DB pool must not be opened for a non-active
    // `database_status`. The route exits before any customer-DB
    // query (cache lookup, redaction, ingest, result write).
    expect(customerPool.query).not.toHaveBeenCalled();
    expect(customerPool.connect).not.toHaveBeenCalled();
  });

  it("database_status=failed is rejected the same way", async () => {
    pushStub({
      match: (s) => /FROM customers WHERE id = \$1/.test(s),
      rows: [{ id: CUSTOMER_ID, database_status: "failed", status: "active" }],
    });
    const res = await callPOST(makeRequest(defaultBody()));
    expect(res.status).toBe(403);
    expect(mockAuthorize).toHaveBeenCalledOnce();
    expect(customerPool.query).not.toHaveBeenCalled();
  });

  it("authorization_failed responses carry an indistinguishable message body", async () => {
    // All four `authorization_failed` paths (missing customer, denied
    // authorize, customers.status non-active, database_status non-active)
    // must return the same message so a probing caller cannot tell
    // which gate rejected them.
    const seenMessages = new Set<string>();

    // 1. external_key resolves to no row.
    mockGetCustomerByExternalKey.mockResolvedValue(null);
    {
      const body = defaultBody({ external_key: "ghost" });
      delete (body as Record<string, unknown>).customer_id;
      const res = await callPOST(makeRequest(body));
      const json = await res.json();
      expect(json.error.code).toBe("authorization_failed");
      seenMessages.add(json.error.message);
    }

    // 2. authorize() returns not-authorized.
    mockAuthorize.mockResolvedValue({
      authorized: false,
      reason: "rbac_denied",
    });
    stubActiveCustomerLookup();
    {
      const res = await callPOST(makeRequest(defaultBody()));
      const json = await res.json();
      expect(json.error.code).toBe("authorization_failed");
      seenMessages.add(json.error.message);
    }

    // 3. database_status non-active.
    mockAuthorize.mockResolvedValue({ authorized: true });
    pushStub({
      match: (s) => /FROM customers WHERE id = \$1/.test(s),
      rows: [
        { id: CUSTOMER_ID, database_status: "provisioning", status: "active" },
      ],
    });
    {
      const res = await callPOST(makeRequest(defaultBody()));
      const json = await res.json();
      expect(json.error.code).toBe("authorization_failed");
      seenMessages.add(json.error.message);
    }

    // All three responses MUST share a single message string.
    expect(seenMessages.size).toBe(1);
  });

  it("database_status=active but customers.status=suspended also fails (authorize gate)", async () => {
    pushStub({
      match: (s) => /FROM customers WHERE id = \$1/.test(s),
      rows: [
        { id: CUSTOMER_ID, database_status: "active", status: "suspended" },
      ],
    });
    mockAuthorize.mockResolvedValue({ authorized: false });
    const res = await callPOST(makeRequest(defaultBody()));
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.code).toBe("authorization_failed");
  });
});

// ---------------------------------------------------------------------------
// Hallucination handling
// ---------------------------------------------------------------------------

describe("POST /api/analysis/analyze — hallucination handling", () => {
  it("emits ai_analysis.hallucination_detected when the scan reports any count", async () => {
    stubActiveCustomerLookup();
    stubCacheMiss();
    stubInsertDetectionEvent();
    stubInsertAnalysisResult();
    mockScanHallucinations.mockReturnValue({
      scanned: "<<UNVERIFIED_IP_001>>",
      counts: { ip: 1, email: 0, mac: 0 },
    });

    const res = await callPOST(makeRequest(defaultBody()));
    expect(res.status).toBe(200);
    expect(mockAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "ai_analysis.hallucination_detected",
        details: expect.objectContaining({
          counts: { ip: 1, email: 0, mac: 0 },
        }),
      }),
    );
  });

  it("does NOT emit hallucination_detected when the scan reports zero counts", async () => {
    stubActiveCustomerLookup();
    stubCacheMiss();
    stubInsertDetectionEvent();
    stubInsertAnalysisResult();

    const res = await callPOST(makeRequest(defaultBody()));
    expect(res.status).toBe(200);
    const hallucinationCalls = mockAuditLog.mock.calls.filter((c) => {
      const arg = (c as unknown as Array<{ action?: string }>)[0];
      return arg?.action === "ai_analysis.hallucination_detected";
    });
    expect(hallucinationCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Aimer-side error mapping
// ---------------------------------------------------------------------------

describe("POST /api/analysis/analyze — aimer error mapping", () => {
  function makeClientError(status: number, errors?: { message: string }[]) {
    // graphql-request's ClientError takes opaque GraphQLResponse and
    // GraphQLRequestContext objects. The route only reads `status` and
    // `errors`, so we hand-build a minimal subset and cast through
    // `unknown` to satisfy the constructor signature.
    const response = {
      status,
      errors,
      headers: new Headers(),
    } as unknown as ConstructorParameters<typeof ClientError>[0];
    const request = {
      query: "x",
      variables: undefined,
    } as unknown as ConstructorParameters<typeof ClientError>[1];
    return new ClientError(response, request);
  }

  it("maps 401 → aimer_auth_failed", async () => {
    stubActiveCustomerLookup();
    stubCacheMiss();
    stubInsertDetectionEvent();
    mockGraphqlRequest.mockRejectedValue(makeClientError(401));
    const res = await callPOST(makeRequest(defaultBody()));
    expect(res.status).toBe(502);
    expect((await res.json()).error.code).toBe("aimer_auth_failed");
  });

  it("maps 4xx with GraphQL errors → aimer_invalid_request", async () => {
    stubActiveCustomerLookup();
    stubCacheMiss();
    stubInsertDetectionEvent();
    mockGraphqlRequest.mockRejectedValue(
      makeClientError(400, [{ message: "bad var" }]),
    );
    const res = await callPOST(makeRequest(defaultBody()));
    expect(res.status).toBe(502);
    expect((await res.json()).error.code).toBe("aimer_invalid_request");
  });

  it("maps 5xx → aimer_call_failed (retryable)", async () => {
    stubActiveCustomerLookup();
    stubCacheMiss();
    stubInsertDetectionEvent();
    mockGraphqlRequest.mockRejectedValue(makeClientError(503));
    const res = await callPOST(makeRequest(defaultBody()));
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error.code).toBe("aimer_call_failed");
    expect(body.error.retryable).toBe(true);
  });

  it("maps transport errors (non-ClientError) → aimer_unavailable", async () => {
    stubActiveCustomerLookup();
    stubCacheMiss();
    stubInsertDetectionEvent();
    mockGraphqlRequest.mockRejectedValue(new TypeError("fetch failed"));
    const res = await callPOST(makeRequest(defaultBody()));
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error.code).toBe("aimer_unavailable");
    expect(body.error.retryable).toBe(true);
  });
});
