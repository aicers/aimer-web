// #463 — in-app single-event regenerate endpoint tests.
//
// Locks in: path validation, origin/CSRF (stubbed pass), analyst write
// authorization (`analyses:configure`, `operationKind: "write"`), the
// existence-hiding 404 for non-members, the bridge-write 403 reason, the
// 404 when no `detection_events` row survives, sourcing the redacted event
// + recovered event_time + stored redaction_policy_version from storage,
// regenerating the REQUESTED variant (not the default), and 200 {generation}.

import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mockAuthorize = vi.fn();
const mockClientQuery = vi.fn();
const mockConnect = vi.fn(() => ({
  query: mockClientQuery,
  release: vi.fn(),
}));
const mockCustomerPoolQuery = vi.fn();
const mockAnalyzeAndStore = vi.fn();
const mockDecryptRedactionMap = vi.fn();
const mockLoadRanges = vi.fn();
const mockLoadDomains = vi.fn();

const SELF = "00000000-0000-0000-0000-000000000099";
const CUSTOMER_ID = "c0000000-0000-0000-0000-000000000001";
const OTHER_CUSTOMER_ID = "c0000000-0000-0000-0000-000000000002";
const AICE_ID = "aice-1";
const EVENT_KEY = "1001";
const BRIDGE_AICE_ID = "aice-bridge-1";
const STORED_EVENT_TIME = "2026-05-20T00:00:00Z";

const authMode = { current: "authed" as "authed" | "unauthed" };
const bridgeOverride = {
  current: null as { bridgeAiceId: string; bridgeCustomerIds: string[] } | null,
};

vi.mock("@/lib/auth/guards", () => ({
  // biome-ignore lint/complexity/noBannedTypes: test mock
  withAuth: (handler: Function) => (req: NextRequest) => {
    if (authMode.current === "unauthed") {
      return Response.json({ error: "unauthorized" }, { status: 401 });
    }
    return handler(req, {
      accountId: SELF,
      sessionId: "sess-1",
      authContext: "general",
      tokenVersion: 1,
      iat: 1000,
      meta: { ipAddress: "127.0.0.1", userAgent: "test" },
      bridgeAiceId: bridgeOverride.current?.bridgeAiceId ?? null,
      bridgeCustomerIds: bridgeOverride.current?.bridgeCustomerIds ?? null,
      audit: {},
    });
  },
  verifyOrigin: () => null,
  verifyCsrf: () => null,
}));

vi.mock("@/lib/auth/authorization", () => ({
  authorize: (...args: unknown[]) => mockAuthorize(...args),
}));

vi.mock("@/lib/db/client", () => ({
  getAuthPool: () => ({ connect: mockConnect }),
}));

vi.mock("@/lib/db/customer-runtime-pool", () => ({
  getCustomerRuntimePool: () => ({ query: mockCustomerPoolQuery }),
}));

vi.mock("@/lib/analysis/run-analyze-flow", () => ({
  analyzeAndStoreEventResult: (...args: unknown[]) =>
    mockAnalyzeAndStore(...args),
  isSupportedLang: (v: string) => v === "KOREAN" || v === "ENGLISH",
}));

vi.mock("@/lib/redaction", () => ({
  decryptRedactionMap: (...args: unknown[]) => mockDecryptRedactionMap(...args),
  loadCustomerRanges: (...args: unknown[]) => mockLoadRanges(...args),
  loadCustomerOwnedDomains: (...args: unknown[]) => mockLoadDomains(...args),
}));

function eventRequest(
  query = "",
  overrides?: { eventKey?: string },
): NextRequest {
  const ek = overrides?.eventKey ?? EVENT_KEY;
  return new NextRequest(
    new URL(
      `http://localhost:3000/api/subjects/${CUSTOMER_ID}/aice/${AICE_ID}/events/${ek}/regenerate${query}`,
    ),
    { method: "POST" },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
  authMode.current = "authed";
  bridgeOverride.current = null;
  mockAuthorize.mockResolvedValue({
    authorized: true,
    permissions: new Set(["analyses:configure"]),
  });
  // detection_events row, then the prior-kind lookup (#552), then the
  // event_redaction_map row.
  mockCustomerPoolQuery
    .mockResolvedValueOnce({
      rows: [
        {
          redacted_event: { event_time: STORED_EVENT_TIME, foo: "bar" },
          redaction_policy_version: "policy-v7",
        },
      ],
    })
    .mockResolvedValueOnce({ rows: [{ kind: "HttpThreat" }] })
    .mockResolvedValueOnce({
      rows: [{ ciphertext: Buffer.from("ct"), wrapped_dek: "dek" }],
    });
  mockDecryptRedactionMap.mockResolvedValue({});
  mockLoadRanges.mockResolvedValue({ normalisedCidrs: [] });
  mockLoadDomains.mockResolvedValue({ normalisedSuffixes: [] });
  mockAnalyzeAndStore.mockResolvedValue({ kind: "success", generation: 2 });
});

describe("event regenerate", () => {
  it("returns 200 {generation} on the happy path", async () => {
    const { POST } = await import("../regenerate/route");
    const res = await POST(eventRequest());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ generation: 2 });
  });

  it("authorizes analyses:configure as a write op with no bridge scope", async () => {
    const { POST } = await import("../regenerate/route");
    await POST(eventRequest());
    expect(mockAuthorize).toHaveBeenCalledWith(
      expect.anything(),
      "general",
      SELF,
      "analyses:configure",
      expect.objectContaining({
        customerId: CUSTOMER_ID,
        aiceId: AICE_ID,
        requiresAiceId: true,
        operationKind: "write",
        bridgeScope: null,
      }),
    );
  });

  it("sources the redacted event + recovers event_time + stamps stored policy", async () => {
    const { POST } = await import("../regenerate/route");
    await POST(eventRequest());
    // First customer-DB query is the detection_events source lookup.
    expect(String(mockCustomerPoolQuery.mock.calls[0][0])).toContain(
      "FROM detection_events",
    );
    expect(mockAnalyzeAndStore).toHaveBeenCalledWith(
      expect.objectContaining({
        aiceId: AICE_ID,
        eventKey: EVENT_KEY,
        redactedEvent: { event_time: STORED_EVENT_TIME, foo: "bar" },
        eventTimeForAimer: STORED_EVENT_TIME,
        redactionPolicyVersion: "policy-v7",
        accountId: SELF,
        force: true,
        // Carries forward the event-level kind from the prior leaf (#552).
        eventKind: "HttpThreat",
      }),
    );
  });

  it("regenerates the REQUESTED variant, not the default", async () => {
    const { POST } = await import("../regenerate/route");
    await POST(eventRequest("?lang=KOREAN&model_name=anthropic&model=claude"));
    expect(mockAnalyzeAndStore).toHaveBeenCalledWith(
      expect.objectContaining({
        lang: "KOREAN",
        langForStorage: "KOREAN",
        modelName: "anthropic",
        model: "claude",
      }),
    );
  });

  it("returns 404 when no detection_events row exists", async () => {
    mockCustomerPoolQuery.mockReset().mockResolvedValueOnce({ rows: [] });
    const { POST } = await import("../regenerate/route");
    const res = await POST(eventRequest());
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("source_unavailable");
    expect(mockAnalyzeAndStore).not.toHaveBeenCalled();
  });

  it("returns 401 when unauthenticated", async () => {
    authMode.current = "unauthed";
    const { POST } = await import("../regenerate/route");
    const res = await POST(eventRequest());
    expect(res.status).toBe(401);
    expect(mockAuthorize).not.toHaveBeenCalled();
  });

  it("returns 404 event_not_found for a non-member (existence-hiding)", async () => {
    mockAuthorize.mockResolvedValue({ authorized: false });
    const { POST } = await import("../regenerate/route");
    const res = await POST(eventRequest());
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("event_not_found");
  });

  it("returns 403 Forbidden for a member lacking analyses:configure", async () => {
    mockAuthorize.mockResolvedValue({
      authorized: false,
      permissions: new Set(["analyses:read"]),
    });
    const { POST } = await import("../regenerate/route");
    const res = await POST(eventRequest());
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("Forbidden");
  });

  it("rejects a bridge-session analyst with bridge_write_blocked at 403", async () => {
    bridgeOverride.current = {
      bridgeAiceId: BRIDGE_AICE_ID,
      bridgeCustomerIds: [CUSTOMER_ID],
    };
    mockAuthorize.mockResolvedValue({
      authorized: false,
      reason: "bridge_write_blocked",
    });
    const { POST } = await import("../regenerate/route");
    const res = await POST(eventRequest());
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("bridge_write_blocked");
    expect(mockAuthorize).toHaveBeenCalledWith(
      expect.anything(),
      "general",
      SELF,
      "analyses:configure",
      expect.objectContaining({
        operationKind: "write",
        bridgeScope: {
          aiceId: BRIDGE_AICE_ID,
          customerIds: [CUSTOMER_ID],
        },
      }),
    );
  });

  it("returns existence-hiding 404 for a bridge session outside scope", async () => {
    bridgeOverride.current = {
      bridgeAiceId: BRIDGE_AICE_ID,
      bridgeCustomerIds: [OTHER_CUSTOMER_ID],
    };
    mockAuthorize.mockResolvedValue({ authorized: false });
    const { POST } = await import("../regenerate/route");
    const res = await POST(eventRequest());
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("event_not_found");
  });

  it("rejects an unknown lang with 400 invalid_param before authorize", async () => {
    const { POST } = await import("../regenerate/route");
    const res = await POST(eventRequest("?lang=FRENCH"));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_param");
    expect(mockAuthorize).not.toHaveBeenCalled();
  });

  it("returns 400 on a malformed event_key", async () => {
    const { POST } = await import("../regenerate/route");
    const res = await POST(eventRequest("", { eventKey: "01" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_event_key");
    expect(mockAuthorize).not.toHaveBeenCalled();
  });

  it("surfaces an aimer call failure from the shared helper", async () => {
    mockAnalyzeAndStore.mockResolvedValue({
      kind: "error",
      errorCode: "aimer_unavailable",
      message: "aimer down",
    });
    const { POST } = await import("../regenerate/route");
    const res = await POST(eventRequest());
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error.code).toBe("aimer_unavailable");
  });
});
