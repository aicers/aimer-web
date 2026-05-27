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
// RFC 3339 / ISO 8601 date-time. Distinct from EVENT_KEY so the tests
// assert the BFF reads `eventTime` from `event_data.event_time`, not
// from the row identifier. See `src/lib/event-key.ts` on why event_key
// carries no timestamp semantics.
const EVENT_TIME = "2026-05-23T05:14:22Z";

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
    event_data: {
      event_key: EVENT_KEY,
      event_time: EVENT_TIME,
      hello: "world",
    },
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

const SYNTHETIC_EVENT_ID = "00000000-0000-0000-0000-00000000ee01";

function stubInsertDetectionEvent({
  rowCount = 1,
  id = SYNTHETIC_EVENT_ID,
  rows,
}: {
  rowCount?: number;
  id?: string;
  rows?: Record<string, unknown>[];
} = {}) {
  pushStub({
    match: (s) => /INSERT INTO detection_events/.test(s),
    rowCount,
    rows: rows ?? (rowCount > 0 ? [{ id }] : []),
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
    redacted: {
      event_key: EVENT_KEY,
      event_time: EVENT_TIME,
      hello: "world",
    },
    mergedMap: {},
    policyVersion: "engine:1.0.0|ranges:empty",
    mapChanged: false,
  });
  mockScanHallucinations.mockReset().mockReturnValue({
    scanned: "analysis text",
    counts: { ip: 0, email: 0, mac: 0 },
  });
  mockGraphqlRequest.mockReset().mockResolvedValue({
    analyzeEvent: {
      severityScore: 0.42,
      likelihoodScore: 0.42,
      severityFactors: ["broad blast radius"],
      likelihoodFactors: ["lateral movement potential"],
      ttpTags: [],
      analysis: "analysis text",
    },
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

  it("synthetic ingest emits detection_events.transfer_approved with [<single>] eventIds", async () => {
    // The synthetic single-event ingest path must surface in the
    // detection_events transfer audit stream — same shape as the
    // staged-approve route's emission — so manual analyze-triggered
    // ingests are not invisible to operators reviewing the
    // detection-events approval audit feed.
    stubActiveCustomerLookup();
    stubCacheMiss();
    stubInsertDetectionEvent({ id: SYNTHETIC_EVENT_ID });
    stubInsertAnalysisResult();

    const res = await callPOST(makeRequest(defaultBody()));
    expect(res.status).toBe(200);
    expect(mockAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "detection_events.transfer_approved",
        // `targetId` is the synthetic `detection_events.id` so the
        // audit row's `targetType` must be `detection_events` — not
        // the route's default `event_analysis_result`, which would
        // make the target id resolve against the wrong table.
        targetType: "detection_events",
        targetId: SYNTHETIC_EVENT_ID,
        details: expect.objectContaining({
          customerId: CUSTOMER_ID,
          eventIds: [SYNTHETIC_EVENT_ID],
        }),
      }),
    );
  });

  it("existing-event path does NOT emit detection_events.transfer_approved", async () => {
    // When the route falls through to an already-existing
    // `detection_events` row (no synthetic ingest happened), it must
    // NOT emit a transfer_approved entry — otherwise every cache-miss
    // analyze of an already-ingested event would forge a phantom
    // ingest audit.
    stubActiveCustomerLookup();
    stubCacheMiss();
    mockReadMapWithLock.mockResolvedValue({});
    pushStub({
      match: (s) =>
        /SELECT redacted_event FROM detection_events/.test(s) &&
        /WHERE aice_id = \$1/.test(s),
      rows: [
        {
          redacted_event: {
            event_key: EVENT_KEY,
            event_time: EVENT_TIME,
            stored: "yes",
          },
        },
      ],
    });
    stubInsertAnalysisResult();

    const res = await callPOST(makeRequest(defaultBody()));
    expect(res.status).toBe(200);
    const transferCalls = mockAuditLog.mock.calls.filter((c) => {
      const arg = (c as unknown as Array<{ action?: string }>)[0];
      return arg?.action === "detection_events.transfer_approved";
    });
    expect(transferCalls).toHaveLength(0);
  });

  it("event exists, result missing → analyze stored event + store", async () => {
    stubActiveCustomerLookup();
    stubCacheMiss();
    // The existing detection_events row carries a DIFFERENT redacted
    // payload than the caller's request — this is the cache-poisoning
    // surface RFC 0001 explicitly defends against. The aimer call must
    // use the STORED `redacted_event`, not the request body, AND the
    // persisted `event_redaction_map` must not be mutated by this
    // call (so attacker-supplied entities cannot be appended). The
    // stored row also pins `event_time`, so an attacker cannot shift
    // the rendered analysis time by supplying a different value in
    // the request body.
    const storedRedacted = {
      event_key: EVENT_KEY,
      event_time: EVENT_TIME,
      stored: "in-db",
    };
    const storedMap = {
      "<<REDACTED_IP_001>>": { kind: "ip" as const, value: "10.0.0.1" },
    };
    mockReadMapWithLock.mockResolvedValue(storedMap);
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
    // freshly redacted request body. Per aimer's `auth-mtls` resolver,
    // the wire shape is `event: String!` (JSON-stringified) and
    // `eventTime: DateTime!` is sourced from the stored event's
    // `event_time` (RFC 3339) — distinct from the row identifier
    // `event_key`.
    expect(mockGraphqlRequest).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        event: JSON.stringify(storedRedacted),
        eventTime: EVENT_TIME,
      }),
      expect.anything(),
    );
    // The map-write side of the cache-poisoning surface: when the
    // event already exists, the route must NOT redact the caller body
    // or write to event_redaction_map.
    expect(mockRedact).not.toHaveBeenCalled();
    expect(mockWriteMap).not.toHaveBeenCalled();
    // The hallucination scan must run against the STORED map, not a
    // merge that includes entities derived from the request body.
    expect(mockScanHallucinations).toHaveBeenCalledWith(
      expect.any(String),
      storedMap,
      expect.anything(),
    );
  });

  it("force=true + event exists → analyze stored event (does not re-redact request body or mutate map)", async () => {
    stubActiveCustomerLookup();
    // No cache lookup — force=true.
    const storedRedacted = {
      event_key: EVENT_KEY,
      event_time: EVENT_TIME,
      stored: "in-db",
    };
    const storedMap = {
      "<<REDACTED_EMAIL_001>>": {
        kind: "email" as const,
        value: "real@user.example",
      },
    };
    mockReadMapWithLock.mockResolvedValue(storedMap);
    pushStub({
      match: (s) =>
        /SELECT redacted_event FROM detection_events/.test(s) &&
        /WHERE aice_id = \$1/.test(s),
      rows: [{ redacted_event: storedRedacted }],
    });
    stubInsertAnalysisResult();

    // Caller supplies a wildly different `event_data` payload — the
    // route must ignore it and send the stored `redacted_event`. The
    // persisted map must also be untouched so a force replay cannot
    // inject attacker-controlled entities. The caller's `event_time`
    // is the canonical one (and also matches the stored row) — but
    // the route still re-extracts from the stored event for the
    // GraphQL `eventTime`.
    const res = await callPOST(
      makeRequest(
        defaultBody({
          force: true,
          event_data: {
            event_key: EVENT_KEY,
            event_time: EVENT_TIME,
            attacker_supplied: "1.2.3.4",
          },
        }),
      ),
    );
    expect(res.status).toBe(200);
    expect(mockGraphqlRequest).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        event: JSON.stringify(storedRedacted),
        eventTime: EVENT_TIME,
      }),
      expect.anything(),
    );
    expect(mockRedact).not.toHaveBeenCalled();
    expect(mockWriteMap).not.toHaveBeenCalled();
    expect(mockScanHallucinations).toHaveBeenCalledWith(
      expect.any(String),
      storedMap,
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

  it("cache hit succeeds even when event_data.event_time is absent", async () => {
    // `event_time` is only needed to construct the `analyzeEvent`
    // mutation's `eventTime` argument. The cache-hit branch short-
    // circuits before any aimer call, so the route must not reject a
    // cached read just because the caller's payload lacks the field —
    // pre-field cached analyses and clients that have not yet adopted
    // the new field would otherwise regress.
    stubActiveCustomerLookup();
    pushStub({
      match: (s) => s.includes("FROM event_analysis_result"),
      rows: [{ requested_at: new Date() }],
    });

    const body = defaultBody({
      event_data: { event_key: EVENT_KEY, hello: "world" },
    });
    const res = await callPOST(makeRequest(body));
    expect(res.status).toBe(200);
    const resBody = await res.json();
    expect(resBody).toEqual({ view_url: expect.any(String), cached: true });
    expect(mockGraphqlRequest).not.toHaveBeenCalled();
  });

  it("result exists but detection_events swept (force=false) → re-ingest, not cache hit", async () => {
    // Retention can sweep `detection_events` rows while the
    // `event_analysis_result` row survives. In that state a normal
    // `force=false` analyze call must NOT short-circuit on the stale
    // result — RFC 0001's behaviour matrix treats "event missing" as a
    // redact+ingest case regardless of whether a result row exists, and
    // the source app needs the source event re-ingested so the force
    // re-run button comes back and the result page stops showing the
    // retention banner. The cache query embeds an EXISTS check against
    // `detection_events`; when that side fails, the joined query returns
    // zero rows even though `event_analysis_result` has a row, so the
    // route falls through to the event-missing path and UPSERTs the
    // result on top of the surviving cache row.
    stubActiveCustomerLookup();
    // Joined cache query: matches `FROM event_analysis_result` but the
    // EXISTS clause against `detection_events` fails → zero rows.
    pushStub({
      match: (s) => s.includes("FROM event_analysis_result"),
      rows: [],
    });
    stubInsertDetectionEvent();
    stubInsertAnalysisResult();

    const res = await callPOST(makeRequest(defaultBody()));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.cached).toBe(false);
    expect(mockReadMapWithLock).toHaveBeenCalledOnce();
    expect(mockGraphqlRequest).toHaveBeenCalledOnce();
    expect(mockAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "ai_analysis.request_issued",
        details: expect.objectContaining({ cached: false, force: false }),
      }),
    );
    expect(mockAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: "ai_analysis.result_stored" }),
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

  it("returns event_time_invalid when event_data.event_time is missing", async () => {
    // `eventTime: DateTime!` is required by aimer's SDL. The BFF
    // sources it from `event_data.event_time` (RFC 3339 / ISO 8601) —
    // distinct from the row identifier `event_key`. A missing field
    // must be rejected on the aimer-call path before ingest / redaction
    // so the route does not burn aimer call budget on a request the
    // upstream resolver would reject. The rejection is intentionally
    // deferred until after the cache lookup so cache-hit reads remain
    // unaffected (see the cache-hit coverage above).
    stubActiveCustomerLookup();
    stubCacheMiss();
    const res = await callPOST(
      makeRequest(
        defaultBody({
          event_data: { event_key: EVENT_KEY, hello: "world" },
        }),
      ),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("event_time_invalid");
  });

  it("returns event_time_invalid for a shape-malformed event_time (space separator)", async () => {
    // The strict RFC 3339 regex requires `T` between the date and time
    // and an explicit offset; a space separator or naive local time
    // must fail at the BFF rather than reach aimer's `DateTime` parser.
    stubActiveCustomerLookup();
    stubCacheMiss();
    const res = await callPOST(
      makeRequest(
        defaultBody({
          event_data: {
            event_key: EVENT_KEY,
            event_time: "2026-05-23 05:14:22",
            hello: "world",
          },
        }),
      ),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("event_time_invalid");
  });

  it("returns event_time_invalid for a naive local time (no offset)", async () => {
    // Naive local times depend on the BFF process timezone, which is
    // not part of the wire contract; reject them so the rendered
    // analysis time is deterministic across deployments.
    stubActiveCustomerLookup();
    stubCacheMiss();
    const res = await callPOST(
      makeRequest(
        defaultBody({
          event_data: {
            event_key: EVENT_KEY,
            event_time: "2026-05-23T05:14:22",
            hello: "world",
          },
        }),
      ),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("event_time_invalid");
  });

  it("returns event_time_invalid for a calendar-invalid event_time (Feb 30)", async () => {
    // Shape regex alone admits impossible calendar moments like
    // `2026-02-30T00:00:00Z`; the round-trip calendar check defends
    // against JS's silent Feb-30 → Mar-2 rollover, so the BFF rejects
    // them at the wire layer rather than forwarding them to aimer.
    stubActiveCustomerLookup();
    stubCacheMiss();
    const res = await callPOST(
      makeRequest(
        defaultBody({
          event_data: {
            event_key: EVENT_KEY,
            event_time: "2026-02-30T00:00:00Z",
            hello: "world",
          },
        }),
      ),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("event_time_invalid");
  });

  it("returns event_time_invalid for a calendar-invalid event_time (month 13)", async () => {
    stubActiveCustomerLookup();
    stubCacheMiss();
    const res = await callPOST(
      makeRequest(
        defaultBody({
          event_data: {
            event_key: EVENT_KEY,
            event_time: "2026-13-01T00:00:00Z",
            hello: "world",
          },
        }),
      ),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("event_time_invalid");
  });

  it("omits `lang` from the GraphQL variables when the caller omits it (aimer applies its default)", async () => {
    // Upstream `Mutation.analyzeEvent`'s `lang: Language` is nullable.
    // The BFF preserves caller-supplied absence end-to-end so aimer's
    // server-side default kicks in; the persisted cache row falls back
    // to `DEFAULT_LANG` so an explicit follow-up ENGLISH call lands on
    // the same row rather than splitting the (aice_id, event_key,
    // lang, model_name, model) primary key.
    stubActiveCustomerLookup();
    stubCacheMiss();
    stubInsertDetectionEvent();
    stubInsertAnalysisResult();

    const body = defaultBody();
    delete (body as Record<string, unknown>).lang;
    const res = await callPOST(makeRequest(body));
    expect(res.status).toBe(200);
    expect(mockGraphqlRequest).toHaveBeenCalledOnce();
    const variables = mockGraphqlRequest.mock.calls[0]?.[1] as
      | Record<string, unknown>
      | undefined;
    expect(variables).toBeDefined();
    expect(variables).not.toHaveProperty("lang");
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

// ---------------------------------------------------------------------------
// Storage-error surface
// ---------------------------------------------------------------------------

describe("POST /api/analysis/analyze — storage failure mapping", () => {
  it("writeMap() rejection surfaces as storage_failed (not redaction_failed)", async () => {
    // RFC 0001's error table places `event_redaction_map` DB write
    // failures in the `storage_failed` bucket (retryable). Without
    // explicit wrapping the rejection would bubble through the route's
    // generic catch and be reported as the non-retryable
    // `redaction_failed`, which mis-signals the failure kind to
    // callers and prevents legitimate retries.
    stubActiveCustomerLookup();
    stubCacheMiss();
    // Force the redact path: no existing detection_events row, and
    // `mapChanged=true` so the route hits writeMap().
    mockReadMapWithLock.mockResolvedValue(null);
    mockRedact.mockReturnValue({
      redacted: { event_key: EVENT_KEY, hello: "world" },
      mergedMap: {},
      policyVersion: "engine:1.0.0|ranges:empty",
      mapChanged: true,
    });
    mockWriteMap.mockRejectedValue(new Error("connection terminated"));

    const res = await callPOST(makeRequest(defaultBody()));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error.code).toBe("storage_failed");
    expect(body.error.retryable).toBe(true);
    // RFC 0001 defines `ai_analysis.aimer_call_failed` as transport
    // or 5xx from aimer. A local `writeMap()` failure happens before
    // the GraphQL request is issued — mis-emitting `aimer_call_failed`
    // here would tell operators aimer is unhealthy when it was never
    // called.
    const aimerCallFailedCalls = mockAuditLog.mock.calls.filter((c) => {
      const arg = (c as unknown as Array<{ action?: string }>)[0];
      return arg?.action === "ai_analysis.aimer_call_failed";
    });
    expect(aimerCallFailedCalls).toHaveLength(0);
  });

  it("redact() rejection surfaces as redaction_failed and emits redaction.engine_error (not aimer_call_failed)", async () => {
    // Local redaction failures must NOT emit `ai_analysis.aimer_call_failed`
    // — the GraphQL request was never issued. `redaction.engine_error`
    // is the correctly named audit action for an engine-side throw.
    stubActiveCustomerLookup();
    stubCacheMiss();
    mockReadMapWithLock.mockResolvedValue(null);
    mockRedact.mockImplementation(() => {
      throw new Error("engine boom");
    });

    const res = await callPOST(makeRequest(defaultBody()));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error.code).toBe("redaction_failed");

    const auditActions = mockAuditLog.mock.calls.map((c) => {
      const arg = (c as unknown as Array<{ action?: string }>)[0];
      return arg?.action;
    });
    expect(auditActions).toContain("redaction.engine_error");
    expect(auditActions).not.toContain("ai_analysis.aimer_call_failed");
  });
});

// ---------------------------------------------------------------------------
// Internal-error catch-all
// ---------------------------------------------------------------------------

describe("POST /api/analysis/analyze — internal_error catch-all", () => {
  it("unexpected throws outside per-stage catches surface as internal_error", async () => {
    // RFC 0001 lists `internal_error` as the catch-all for the 12-code
    // error contract. Without an outer try/catch, exceptions from
    // `loadCustomerRanges()`, the cache lookup, `scanHallucinations()`,
    // or auth/customer DB reads would escape to Next's generic 500
    // page and break the documented `{ error: { code, ... } }` shape.
    stubActiveCustomerLookup();
    mockLoadCustomerRanges.mockRejectedValueOnce(new Error("auth db down"));

    const res = await callPOST(makeRequest(defaultBody()));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error.code).toBe("internal_error");
  });
});

// ---------------------------------------------------------------------------
// Round-11: severity_factors / likelihood_factors / ttp_tags
// ---------------------------------------------------------------------------

function captureInsertParams(): unknown[] | null {
  // Pull the INSERT INTO event_analysis_result call out of the connect-
  // backed transaction or, when none, the direct pool call. The Pool
  // mock intentionally drops `query` args, but `customerPool.query.mock`
  // does capture them.
  const all = customerPool.query.mock.calls as Array<[string, unknown[]?]>;
  const entry = all.find(([sql]) =>
    /INSERT INTO event_analysis_result/.test(sql),
  );
  return entry?.[1] ?? null;
}

function auditCallsByAction(action: string): Array<Record<string, unknown>> {
  return mockAuditLog.mock.calls
    .map((c) => (c as unknown as Array<Record<string, unknown>>)[0])
    .filter((arg) => arg?.action === action);
}

describe("POST /api/analysis/analyze — factor + TTP filter integration", () => {
  it("happy-path factors persist verbatim, no factor_dropped audit row", async () => {
    stubActiveCustomerLookup();
    stubCacheMiss();
    stubInsertDetectionEvent();
    stubInsertAnalysisResult();
    mockGraphqlRequest.mockResolvedValueOnce({
      analyzeEvent: {
        severityScore: 0.4,
        likelihoodScore: 0.5,
        severityFactors: ["broad blast radius", "lateral movement"],
        likelihoodFactors: ["clean POST", "unusual UA"],
        ttpTags: [],
        analysis: "ok",
      },
    });

    const res = await callPOST(makeRequest(defaultBody()));
    expect(res.status).toBe(200);

    const params = captureInsertParams();
    expect(params).not.toBeNull();
    // Position-dependent on the route's bound parameters; severity_factors
    // is the 8th bound parameter and likelihood_factors the 9th.
    if (params) {
      const sev = JSON.parse(params[7] as string);
      const lik = JSON.parse(params[8] as string);
      expect(sev).toEqual(["broad blast radius", "lateral movement"]);
      expect(lik).toEqual(["clean POST", "unusual UA"]);
    }
    expect(auditCallsByAction("ai_analysis.factor_dropped")).toHaveLength(0);
    expect(auditCallsByAction("ai_analysis.ttp_tag_dropped")).toHaveLength(0);
  });

  it("oversized + empty drops in one axis emit two rows, one per reason", async () => {
    stubActiveCustomerLookup();
    stubCacheMiss();
    stubInsertDetectionEvent();
    stubInsertAnalysisResult();
    const oversized = "x".repeat(81);
    mockGraphqlRequest.mockResolvedValueOnce({
      analyzeEvent: {
        severityScore: 0.5,
        likelihoodScore: 0.5,
        severityFactors: [oversized, "", "good one"],
        likelihoodFactors: ["fine"],
        ttpTags: [],
        analysis: "ok",
      },
    });

    const res = await callPOST(makeRequest(defaultBody()));
    expect(res.status).toBe(200);

    const sevDrops = auditCallsByAction("ai_analysis.factor_dropped").filter(
      (c) => (c.details as Record<string, unknown>).axis === "severity",
    );
    expect(sevDrops).toHaveLength(2);
    const reasons = new Set(
      sevDrops.map((c) => (c.details as Record<string, unknown>).reason),
    );
    expect(reasons).toEqual(new Set(["oversized", "empty"]));
    for (const row of sevDrops) {
      const d = row.details as Record<string, unknown>;
      expect(d.replaced_with_sentinel).toBe(false);
      // Event-level target identifiers must live inside the payload per
      // RFC 0001:756 so consumers do not have to parse `targetId`.
      expect(d.customer_id).toBe(CUSTOMER_ID);
      expect(d.aice_id).toBe(AICE_ID);
      expect(d.event_key).toBe(EVENT_KEY);
      expect(d.story_id).toBeNull();
    }
  });

  it("sentence-start drops emit a single audit row with reason 'sentence_start'", async () => {
    stubActiveCustomerLookup();
    stubCacheMiss();
    stubInsertDetectionEvent();
    stubInsertAnalysisResult();
    mockGraphqlRequest.mockResolvedValueOnce({
      analyzeEvent: {
        severityScore: 0.5,
        likelihoodScore: 0.5,
        severityFactors: ["The attacker pivoted", "This event uses PS", "real"],
        likelihoodFactors: ["fine"],
        ttpTags: [],
        analysis: "ok",
      },
    });

    const res = await callPOST(makeRequest(defaultBody()));
    expect(res.status).toBe(200);

    const sevDrops = auditCallsByAction("ai_analysis.factor_dropped").filter(
      (c) => (c.details as Record<string, unknown>).axis === "severity",
    );
    expect(sevDrops).toHaveLength(1);
    const d = sevDrops[0].details as Record<string, unknown>;
    expect(d.reason).toBe("sentence_start");
    expect(d.dropped_items).toEqual([
      "The attacker pivoted",
      "This event uses PS",
    ]);
    expect(d.customer_id).toBe(CUSTOMER_ID);
    expect(d.aice_id).toBe(AICE_ID);
    expect(d.event_key).toBe(EVENT_KEY);
    expect(d.story_id).toBeNull();
  });

  it("cap-only firing emits NO audit row but stores first 5 items", async () => {
    stubActiveCustomerLookup();
    stubCacheMiss();
    stubInsertDetectionEvent();
    stubInsertAnalysisResult();
    const seven = ["a1", "a2", "a3", "a4", "a5", "a6", "a7"];
    mockGraphqlRequest.mockResolvedValueOnce({
      analyzeEvent: {
        severityScore: 0.5,
        likelihoodScore: 0.5,
        severityFactors: seven,
        likelihoodFactors: ["x"],
        ttpTags: [],
        analysis: "ok",
      },
    });

    const res = await callPOST(makeRequest(defaultBody()));
    expect(res.status).toBe(200);

    const params = captureInsertParams();
    if (params) {
      expect(JSON.parse(params[7] as string)).toEqual(seven.slice(0, 5));
    }
    const sevDrops = auditCallsByAction("ai_analysis.factor_dropped").filter(
      (c) => (c.details as Record<string, unknown>).axis === "severity",
    );
    // RFC 0001:756's reason enum has no cap value — cap-only firing is
    // intentionally non-audited (RFC 0002:725 soft trim).
    expect(sevDrops).toHaveLength(0);
  });

  it("sentinel recovery emits per-reason rows + an 'all_items_filtered' row", async () => {
    stubActiveCustomerLookup();
    stubCacheMiss();
    stubInsertDetectionEvent();
    stubInsertAnalysisResult();
    const rawSeverity = ["The first", "", "x".repeat(81)];
    mockGraphqlRequest.mockResolvedValueOnce({
      analyzeEvent: {
        severityScore: 0.5,
        likelihoodScore: 0.5,
        severityFactors: rawSeverity,
        likelihoodFactors: ["fine"],
        ttpTags: [],
        analysis: "ok",
      },
    });

    const res = await callPOST(makeRequest(defaultBody()));
    expect(res.status).toBe(200);

    // UPSERT writes the sentinel — every input item was filtered out.
    const params = captureInsertParams();
    if (params) {
      expect(JSON.parse(params[7] as string)).toEqual([
        "insufficient evidence",
      ]);
    }

    const sevDrops = auditCallsByAction("ai_analysis.factor_dropped").filter(
      (c) => (c.details as Record<string, unknown>).axis === "severity",
    );
    // Three per-reason rows (sentence_start, empty, oversized) plus one
    // recovery row with reason: 'all_items_filtered'.
    expect(sevDrops).toHaveLength(4);
    const reasons = sevDrops.map(
      (c) => (c.details as Record<string, unknown>).reason,
    );
    expect(new Set(reasons)).toEqual(
      new Set(["sentence_start", "empty", "oversized", "all_items_filtered"]),
    );
    const recovery = sevDrops.find(
      (c) =>
        (c.details as Record<string, unknown>).reason === "all_items_filtered",
    );
    expect(recovery).toBeDefined();
    if (recovery) {
      const d = recovery.details as Record<string, unknown>;
      expect(d.replaced_with_sentinel).toBe(true);
      expect(d.dropped_items).toEqual(rawSeverity);
    }
    for (const row of sevDrops) {
      const d = row.details as Record<string, unknown>;
      expect(d.customer_id).toBe(CUSTOMER_ID);
      expect(d.aice_id).toBe(AICE_ID);
      expect(d.event_key).toBe(EVENT_KEY);
      expect(d.story_id).toBeNull();
    }
  });

  it("ttp drops with mixed reasons emit one row per reason with mitre_vendor_version", async () => {
    stubActiveCustomerLookup();
    stubCacheMiss();
    stubInsertDetectionEvent();
    stubInsertAnalysisResult();
    mockGraphqlRequest.mockResolvedValueOnce({
      analyzeEvent: {
        severityScore: 0.5,
        likelihoodScore: 0.5,
        severityFactors: ["one"],
        likelihoodFactors: ["two"],
        // T1078 / T1110 are real (kept). `bogus` → invalid_format;
        // `T9999` → not_in_vendored_mitre.
        ttpTags: ["T1078", "bogus", "T9999", "T1110"],
        analysis: "ok",
      },
    });

    const res = await callPOST(makeRequest(defaultBody()));
    expect(res.status).toBe(200);

    const params = captureInsertParams();
    if (params) {
      expect(JSON.parse(params[9] as string)).toEqual(["T1078", "T1110"]);
    }

    const ttpRows = auditCallsByAction("ai_analysis.ttp_tag_dropped");
    expect(ttpRows).toHaveLength(2);
    const byReason = new Map(
      ttpRows.map((r) => {
        const d = r.details as Record<string, unknown>;
        return [d.reason, d];
      }),
    );
    expect(byReason.get("invalid_format")?.dropped_ids).toEqual(["bogus"]);
    expect(byReason.get("not_in_vendored_mitre")?.dropped_ids).toEqual([
      "T9999",
    ]);
    for (const row of ttpRows) {
      const d = row.details as Record<string, unknown>;
      expect(typeof d.mitre_vendor_version).toBe("string");
      expect((d.mitre_vendor_version as string).length).toBeGreaterThan(0);
      expect(d.customer_id).toBe(CUSTOMER_ID);
      expect(d.aice_id).toBe(AICE_ID);
      expect(d.event_key).toBe(EVENT_KEY);
      expect(d.story_id).toBeNull();
    }
  });
});
