// RFC 0002 Phase 1 (#296) — story regenerate API tests (Phase 0
// public-shape contract preserved, Phase 1 DB side-effects added).
//
// Locks in: 401 unauthenticated, 404 story_not_found for non-member
// denials (existence-hiding policy from #333), 403 Forbidden for
// member-without-permission, 403 with reason for
// bridge_write_blocked / bridge_not_allowed, 400 invalid_param for tz
// on story, 404 missing state row, 409 archived / no surviving
// version, 202 happy-path returning state_pk + variant + generation.

import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mockAssertAuthorized = vi.fn();
const mockAuthorize = vi.fn();
const mockClientQuery = vi.fn();
const mockConnect = vi.fn(() => ({
  query: mockClientQuery,
  release: vi.fn(),
}));
const mockCustomerPoolQuery = vi.fn();

const SELF = "00000000-0000-0000-0000-000000000099";
const CUSTOMER_ID = "c0000000-0000-0000-0000-000000000001";
const OTHER_CUSTOMER_ID = "c0000000-0000-0000-0000-000000000002";
const BRIDGE_AICE_ID = "aice-bridge-1";

// Toggles `withAuth` between "authed" (calls handler with a stub session)
// and "unauthed" (short-circuits with 401, mirroring the real guard's
// behavior when no valid session cookie is present). The bridge fields
// can be overridden per-test to simulate a bridge-scoped session.
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
  assertAuthorized: (...args: unknown[]) => mockAssertAuthorized(...args),
  authorize: (...args: unknown[]) => mockAuthorize(...args),
}));

vi.mock("@/lib/db/client", () => ({
  getAuthPool: () => ({ connect: mockConnect }),
}));

vi.mock("@/lib/db/customer-runtime-pool", () => ({
  getCustomerRuntimePool: () => ({ query: mockCustomerPoolQuery }),
}));

function storyRequest(query = ""): NextRequest {
  return new NextRequest(
    new URL(
      `http://localhost:3000/api/customers/${CUSTOMER_ID}/analysis/story/12345/regenerate${query}`,
    ),
    { method: "POST" },
  );
}

function reportRequest(query = ""): NextRequest {
  return new NextRequest(
    new URL(
      `http://localhost:3000/api/customers/${CUSTOMER_ID}/analysis/report/DAILY/2026-05-27/regenerate${query}`,
    ),
    { method: "POST" },
  );
}

describe("story regenerate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    authMode.current = "authed";
    bridgeOverride.current = null;
    mockAssertAuthorized.mockResolvedValue(new Set(["analyses:configure"]));
    mockAuthorize.mockResolvedValue({
      authorized: true,
      permissions: new Set(["analyses:configure"]),
    });
    // Default happy-path DB chain: state row exists & ready, story
    // version survives, upsert returns generation=1 as a fresh insert.
    mockClientQuery
      .mockResolvedValueOnce({ rows: [{ status: "ready" }] }) // state row
      .mockResolvedValueOnce({
        rows: [{ generation: 1, inserted: true }],
      }); // upsert RETURNING
    mockCustomerPoolQuery.mockResolvedValueOnce({
      rows: [{ story_version: "v1" }],
    });
  });

  it("returns 202 on the happy path", async () => {
    const { POST } = await import("../story/[storyId]/regenerate/route");
    const res = await POST(storyRequest());
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.accepted).toBe(true);
    expect(body.state_pk).toEqual({
      customer_id: CUSTOMER_ID,
      story_id: "12345",
    });
    expect(body.variant).toEqual({
      lang: "ENGLISH",
      model_name: "openai",
      model: "gpt-4o",
    });
    expect(body.generation).toBe(1);
  });

  it("returns 404 when the state row is missing", async () => {
    mockClientQuery.mockReset().mockResolvedValueOnce({ rows: [] });
    mockCustomerPoolQuery.mockReset();
    const { POST } = await import("../story/[storyId]/regenerate/route");
    const res = await POST(storyRequest());
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("story_not_found");
  });

  it("returns 409 when the state row is archived", async () => {
    mockClientQuery
      .mockReset()
      .mockResolvedValueOnce({ rows: [{ status: "archived" }] });
    mockCustomerPoolQuery.mockReset();
    const { POST } = await import("../story/[storyId]/regenerate/route");
    const res = await POST(storyRequest());
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe("source_unavailable");
  });

  it("returns 409 when no story_version survives", async () => {
    mockClientQuery
      .mockReset()
      .mockResolvedValueOnce({ rows: [{ status: "ready" }] });
    mockCustomerPoolQuery.mockReset().mockResolvedValueOnce({ rows: [] });
    const { POST } = await import("../story/[storyId]/regenerate/route");
    const res = await POST(storyRequest());
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe("source_unavailable");
  });

  it("returns 401 when the request is unauthenticated", async () => {
    authMode.current = "unauthed";
    const { POST } = await import("../story/[storyId]/regenerate/route");
    const res = await POST(storyRequest());
    expect(res.status).toBe(401);
    expect(mockAuthorize).not.toHaveBeenCalled();
  });

  it("returns 404 story_not_found when the caller is not a member of customer_id", async () => {
    // Non-member: `authorizeGeneral` returns `{authorized: false}`
    // with no `permissions` field. Existence-hiding policy collapses
    // this to 404 (RFC 0002 amendment, #333) — uniform with the page
    // route and the summary endpoint.
    mockAuthorize.mockResolvedValue({ authorized: false });
    const { POST } = await import("../story/[storyId]/regenerate/route");
    const res = await POST(storyRequest());
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("story_not_found");
  });

  it("returns 403 when the caller is a member but lacks analyses:configure", async () => {
    // Member: `authorizeGeneral` returns `{authorized: false,
    // permissions: Set<...>}` when the caller holds membership but
    // not the required permission key. Surfaces as a precise 403.
    mockAuthorize.mockResolvedValue({
      authorized: false,
      permissions: new Set(["analyses:read"]),
    });
    const { POST } = await import("../story/[storyId]/regenerate/route");
    const res = await POST(storyRequest());
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe("Forbidden");
  });

  it("rejects tz with 400 invalid_param (story analysis is timezone-independent)", async () => {
    const { POST } = await import("../story/[storyId]/regenerate/route");
    const res = await POST(storyRequest("?tz=Asia/Seoul"));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("invalid_param");
  });

  it("rejects an unknown lang with 400 invalid_param", async () => {
    const { POST } = await import("../story/[storyId]/regenerate/route");
    const res = await POST(storyRequest("?lang=FRENCH"));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("invalid_param");
    expect(mockAuthorize).not.toHaveBeenCalled();
  });

  it("accepts KOREAN as a valid lang override", async () => {
    const { POST } = await import("../story/[storyId]/regenerate/route");
    const res = await POST(storyRequest("?lang=KOREAN"));
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.variant.lang).toBe("KOREAN");
  });

  it("returns 400 on an invalid story id", async () => {
    const { POST } = await import("../story/[storyId]/regenerate/route");
    const req = new NextRequest(
      new URL(
        `http://localhost:3000/api/customers/${CUSTOMER_ID}/analysis/story/not-a-number/regenerate`,
      ),
      { method: "POST" },
    );
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it("authorizes as a write op with no bridge scope for an ordinary session", async () => {
    // Force-regenerate is a write action; the stub locks the auth
    // contract so Phase 1 cannot be reached without `operationKind`.
    const { POST } = await import("../story/[storyId]/regenerate/route");
    const res = await POST(storyRequest());
    expect(res.status).toBe(202);
    expect(mockAuthorize).toHaveBeenCalledWith(
      expect.anything(),
      "general",
      SELF,
      "analyses:configure",
      expect.objectContaining({
        customerId: CUSTOMER_ID,
        operationKind: "write",
        bridgeScope: null,
      }),
    );
  });

  it("rejects bridge sessions with bridge_write_blocked body", async () => {
    // A bridge session scoped to *this* customer must still be
    // rejected: force-regenerate is an analyst UI action, not an
    // AICE-side ingest/process flow. `authorize` returns
    // `bridge_write_blocked` for `operationKind: "write"`, and the
    // route MUST forward that reason as the response body so the
    // client can distinguish bridge-blocked writes from generic
    // 403s (#296 contract / RFC 0002 §"Force regenerate").
    bridgeOverride.current = {
      bridgeAiceId: BRIDGE_AICE_ID,
      bridgeCustomerIds: [CUSTOMER_ID],
    };
    mockAuthorize.mockResolvedValue({
      authorized: false,
      reason: "bridge_write_blocked",
    });
    const { POST } = await import("../story/[storyId]/regenerate/route");
    const res = await POST(storyRequest());
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe("bridge_write_blocked");
    expect(mockAuthorize).toHaveBeenCalledWith(
      expect.anything(),
      "general",
      SELF,
      "analyses:configure",
      expect.objectContaining({
        customerId: CUSTOMER_ID,
        operationKind: "write",
        bridgeScope: {
          aiceId: BRIDGE_AICE_ID,
          customerIds: [CUSTOMER_ID],
        },
      }),
    );
  });

  it("rejects bridge sessions targeting a customer outside bridge scope", async () => {
    // Bridge scoped to OTHER_CUSTOMER_ID, request hits CUSTOMER_ID. Even
    // ignoring the write-block, `authorize` returns
    // `{authorized: false}` with no `reason` and no `permissions`
    // when `customerId` is not in `bridgeScope.customerIds`. Under
    // the existence-hiding policy (#333) the route collapses this
    // to 404 — the bridge session must not be able to confirm whether
    // a story id exists in a customer outside its scope.
    bridgeOverride.current = {
      bridgeAiceId: BRIDGE_AICE_ID,
      bridgeCustomerIds: [OTHER_CUSTOMER_ID],
    };
    mockAuthorize.mockResolvedValue({ authorized: false });
    const { POST } = await import("../story/[storyId]/regenerate/route");
    const res = await POST(storyRequest());
    expect(res.status).toBe(404);
    expect(mockAuthorize).toHaveBeenCalledWith(
      expect.anything(),
      "general",
      SELF,
      "analyses:configure",
      expect.objectContaining({
        customerId: CUSTOMER_ID,
        operationKind: "write",
        bridgeScope: {
          aiceId: BRIDGE_AICE_ID,
          customerIds: [OTHER_CUSTOMER_ID],
        },
      }),
    );
  });
});

describe("report regenerate (Phase 2 #297)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    authMode.current = "authed";
    bridgeOverride.current = null;
    mockAuthorize.mockResolvedValue({
      authorized: true,
      permissions: new Set(["reports:create"]),
    });
    // Default happy-path DB chain (tz supplied → no customers lookup):
    // state row ready, then upsert RETURNING generation=1.
    mockClientQuery
      .mockResolvedValueOnce({ rows: [{ status: "ready" }] })
      .mockResolvedValueOnce({ rows: [{ generation: 1, inserted: true }] });
  });

  it("returns 401 when the request is unauthenticated", async () => {
    authMode.current = "unauthed";
    const { POST } = await import(
      "../report/[period]/[bucketDate]/regenerate/route"
    );
    const res = await POST(reportRequest("?tz=Asia/Tokyo"));
    expect(res.status).toBe(401);
    expect(mockAuthorize).not.toHaveBeenCalled();
  });

  it("returns 404 report_state_not_found when the caller is not a member", async () => {
    mockAuthorize.mockResolvedValue({ authorized: false });
    const { POST } = await import(
      "../report/[period]/[bucketDate]/regenerate/route"
    );
    const res = await POST(reportRequest("?tz=Asia/Tokyo"));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("report_state_not_found");
  });

  it("returns 403 Forbidden when the caller is a member lacking reports:create", async () => {
    mockAuthorize.mockResolvedValue({
      authorized: false,
      permissions: new Set(["reports:read"]),
    });
    const { POST } = await import(
      "../report/[period]/[bucketDate]/regenerate/route"
    );
    const res = await POST(reportRequest("?tz=Asia/Tokyo"));
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe("Forbidden");
  });

  it("returns 202 on the happy path with optional tz/lang/model", async () => {
    const { POST } = await import(
      "../report/[period]/[bucketDate]/regenerate/route"
    );
    const res = await POST(
      reportRequest("?tz=Asia/Tokyo&lang=ENGLISH&model=gpt-4o"),
    );
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.accepted).toBe(true);
    expect(body.state_pk).toEqual({
      customer_id: CUSTOMER_ID,
      period: "DAILY",
      bucket_date: "2026-05-27",
      tz: "Asia/Tokyo",
    });
    expect(body.variant).toEqual({
      tz: "Asia/Tokyo",
      lang: "ENGLISH",
      model_name: "openai",
      model: "gpt-4o",
    });
    expect(body.generation).toBe(1);
  });

  it("defaults tz to the customer's current timezone when not supplied", async () => {
    mockClientQuery
      .mockReset()
      .mockResolvedValueOnce({ rows: [{ timezone: "Asia/Seoul" }] }) // customers
      .mockResolvedValueOnce({ rows: [{ status: "ready" }] }) // state row
      .mockResolvedValueOnce({ rows: [{ generation: 1, inserted: true }] });
    const { POST } = await import(
      "../report/[period]/[bucketDate]/regenerate/route"
    );
    const res = await POST(reportRequest());
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.variant.tz).toBe("Asia/Seoul");
  });

  it("returns 404 report_state_not_found when the state row is missing", async () => {
    mockClientQuery.mockReset().mockResolvedValueOnce({ rows: [] });
    const { POST } = await import(
      "../report/[period]/[bucketDate]/regenerate/route"
    );
    const res = await POST(reportRequest("?tz=Asia/Tokyo"));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("report_state_not_found");
  });

  it("returns 409 source_unavailable when the state row is archived", async () => {
    mockClientQuery
      .mockReset()
      .mockResolvedValueOnce({ rows: [{ status: "archived" }] });
    const { POST } = await import(
      "../report/[period]/[bucketDate]/regenerate/route"
    );
    const res = await POST(reportRequest("?tz=Asia/Tokyo"));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe("source_unavailable");
  });

  // #298: WEEKLY/MONTHLY are now processed (the Phase 2 rejection was
  // lifted), so a force-regenerate on either period reaches the UPSERT
  // and returns 202 like LIVE/DAILY.
  it.each([
    "WEEKLY",
    "MONTHLY",
  ])("returns 202 for %s (period rejection lifted in #298)", async (period) => {
    const { POST } = await import(
      "../report/[period]/[bucketDate]/regenerate/route"
    );
    const req = new NextRequest(
      new URL(
        `http://localhost:3000/api/customers/${CUSTOMER_ID}/analysis/report/${period}/2026-05-27/regenerate?tz=Asia/Tokyo`,
      ),
      { method: "POST" },
    );
    const res = await POST(req);
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.accepted).toBe(true);
    expect(body.state_pk.period).toBe(period);
    expect(mockAuthorize).toHaveBeenCalled();
  });

  it("a denied caller requesting WEEKLY still sees its denial code", async () => {
    // Non-member requesting WEEKLY must get 404 (existence-hiding) — auth
    // is evaluated before the source-availability precheck.
    mockAuthorize.mockResolvedValue({ authorized: false });
    const { POST } = await import(
      "../report/[period]/[bucketDate]/regenerate/route"
    );
    const req = new NextRequest(
      new URL(
        `http://localhost:3000/api/customers/${CUSTOMER_ID}/analysis/report/WEEKLY/2026-05-27/regenerate?tz=Asia/Tokyo`,
      ),
      { method: "POST" },
    );
    const res = await POST(req);
    expect(res.status).toBe(404);
  });

  it("returns 400 on an unknown period", async () => {
    const { POST } = await import(
      "../report/[period]/[bucketDate]/regenerate/route"
    );
    const req = new NextRequest(
      new URL(
        `http://localhost:3000/api/customers/${CUSTOMER_ID}/analysis/report/HOURLY/2026-05-27/regenerate`,
      ),
      { method: "POST" },
    );
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it("returns 400 on a malformed bucket_date", async () => {
    const { POST } = await import(
      "../report/[period]/[bucketDate]/regenerate/route"
    );
    const req = new NextRequest(
      new URL(
        `http://localhost:3000/api/customers/${CUSTOMER_ID}/analysis/report/DAILY/today/regenerate`,
      ),
      { method: "POST" },
    );
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it.each([
    "2026-99-99",
    "2026-02-31",
    "2026-13-01",
    "2025-02-29",
    "2026-04-31",
    "2026-00-15",
    "2026-01-00",
  ])("returns 400 on impossible calendar date %s", async (bucketDate) => {
    const { POST } = await import(
      "../report/[period]/[bucketDate]/regenerate/route"
    );
    const req = new NextRequest(
      new URL(
        `http://localhost:3000/api/customers/${CUSTOMER_ID}/analysis/report/DAILY/${bucketDate}/regenerate`,
      ),
      { method: "POST" },
    );
    const res = await POST(req);
    expect(res.status).toBe(400);
    expect(mockAuthorize).not.toHaveBeenCalled();
  });

  it.each([
    "2026-05-27",
    "1970-01-02",
    "2024-02-29",
    "1970-12-31",
  ])("returns 400 on period=LIVE with non-epoch bucket_date %s", async (bucketDate) => {
    const { POST } = await import(
      "../report/[period]/[bucketDate]/regenerate/route"
    );
    const req = new NextRequest(
      new URL(
        `http://localhost:3000/api/customers/${CUSTOMER_ID}/analysis/report/LIVE/${bucketDate}/regenerate`,
      ),
      { method: "POST" },
    );
    const res = await POST(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("invalid_report_path");
    expect(mockAuthorize).not.toHaveBeenCalled();
  });

  it("accepts period=LIVE with bucket_date=1970-01-01", async () => {
    const { POST } = await import(
      "../report/[period]/[bucketDate]/regenerate/route"
    );
    const req = new NextRequest(
      new URL(
        `http://localhost:3000/api/customers/${CUSTOMER_ID}/analysis/report/LIVE/1970-01-01/regenerate?tz=Asia/Tokyo`,
      ),
      { method: "POST" },
    );
    const res = await POST(req);
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.state_pk.period).toBe("LIVE");
    expect(body.state_pk.bucket_date).toBe("1970-01-01");
  });

  it("accepts a real leap-year date (2024-02-29)", async () => {
    const { POST } = await import(
      "../report/[period]/[bucketDate]/regenerate/route"
    );
    const req = new NextRequest(
      new URL(
        `http://localhost:3000/api/customers/${CUSTOMER_ID}/analysis/report/DAILY/2024-02-29/regenerate?tz=Asia/Tokyo`,
      ),
      { method: "POST" },
    );
    const res = await POST(req);
    expect(res.status).toBe(202);
  });

  it("authorizes as a write op (reports:create) with no bridge scope", async () => {
    const { POST } = await import(
      "../report/[period]/[bucketDate]/regenerate/route"
    );
    const res = await POST(reportRequest("?tz=Asia/Tokyo"));
    expect(res.status).toBe(202);
    expect(mockAuthorize).toHaveBeenCalledWith(
      expect.anything(),
      "general",
      SELF,
      "reports:create",
      expect.objectContaining({
        customerId: CUSTOMER_ID,
        operationKind: "write",
        bridgeScope: null,
      }),
    );
  });

  it("rejects bridge sessions with the bridge reason at 403", async () => {
    bridgeOverride.current = {
      bridgeAiceId: BRIDGE_AICE_ID,
      bridgeCustomerIds: [CUSTOMER_ID],
    };
    mockAuthorize.mockResolvedValue({
      authorized: false,
      reason: "bridge_write_blocked",
    });
    const { POST } = await import(
      "../report/[period]/[bucketDate]/regenerate/route"
    );
    const res = await POST(reportRequest("?tz=Asia/Tokyo"));
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe("bridge_write_blocked");
  });

  it("rejects bridge sessions outside scope with existence-hiding 404", async () => {
    bridgeOverride.current = {
      bridgeAiceId: BRIDGE_AICE_ID,
      bridgeCustomerIds: [OTHER_CUSTOMER_ID],
    };
    mockAuthorize.mockResolvedValue({ authorized: false });
    const { POST } = await import(
      "../report/[period]/[bucketDate]/regenerate/route"
    );
    const res = await POST(reportRequest("?tz=Asia/Tokyo"));
    expect(res.status).toBe(404);
  });
});
