// RFC 0002 Phase 0 (#294) — regenerate API stub tests.
//
// Locks in the public-shape contract: 401 unauthenticated, 403
// non-member / missing permission, 400 invalid_param for tz on story,
// 202 happy-path.

import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockAssertAuthorized = vi.fn();
const mockClientQuery = vi.fn();
const mockConnect = vi.fn(() => ({
  query: mockClientQuery,
  release: vi.fn(),
}));

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
}));

vi.mock("@/lib/db/client", () => ({
  getAuthPool: () => ({ connect: mockConnect }),
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

describe("story regenerate stub", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    authMode.current = "authed";
    bridgeOverride.current = null;
    mockAssertAuthorized.mockResolvedValue(new Set(["analyses:configure"]));
  });

  it("returns 202 on the happy path", async () => {
    const { POST } = await import("../story/[storyId]/regenerate/route");
    const res = await POST(storyRequest());
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.accepted).toBe(true);
    expect(body.story_id).toBe("12345");
    expect(body.customer_id).toBe(CUSTOMER_ID);
  });

  it("returns 401 when the request is unauthenticated", async () => {
    authMode.current = "unauthed";
    const { POST } = await import("../story/[storyId]/regenerate/route");
    const res = await POST(storyRequest());
    expect(res.status).toBe(401);
    expect(mockAssertAuthorized).not.toHaveBeenCalled();
  });

  it("returns 403 when the caller is not a member of customer_id", async () => {
    // assertAuthorized throws the same HttpError("Forbidden", 403) for
    // both non-member and missing-permission rejections (see
    // src/lib/auth/authorization.ts). This test pins the non-member
    // branch explicitly so the stub-level contract is reviewable.
    const { HttpError } = await import("@/lib/auth/errors");
    mockAssertAuthorized.mockRejectedValue(new HttpError("Forbidden", 403));
    const { POST } = await import("../story/[storyId]/regenerate/route");
    const res = await POST(storyRequest());
    expect(res.status).toBe(403);
  });

  it("returns 403 when the caller lacks analyses:configure", async () => {
    const { HttpError } = await import("@/lib/auth/errors");
    mockAssertAuthorized.mockRejectedValue(new HttpError("Forbidden", 403));
    const { POST } = await import("../story/[storyId]/regenerate/route");
    const res = await POST(storyRequest());
    expect(res.status).toBe(403);
  });

  it("rejects tz with 400 invalid_param (story analysis is timezone-independent)", async () => {
    const { POST } = await import("../story/[storyId]/regenerate/route");
    const res = await POST(storyRequest("?tz=Asia/Seoul"));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("invalid_param");
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
    expect(mockAssertAuthorized).toHaveBeenCalledWith(
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

  it("rejects bridge sessions (writes are blocked in bridge sessions)", async () => {
    // A bridge session scoped to *this* customer must still be
    // rejected: force-regenerate is an analyst UI action, not an
    // AICE-side ingest/process flow. `authorize` returns
    // `bridge_write_blocked` for `operationKind: "write"`.
    bridgeOverride.current = {
      bridgeAiceId: BRIDGE_AICE_ID,
      bridgeCustomerIds: [CUSTOMER_ID],
    };
    const { HttpError } = await import("@/lib/auth/errors");
    mockAssertAuthorized.mockRejectedValue(new HttpError("Forbidden", 403));
    const { POST } = await import("../story/[storyId]/regenerate/route");
    const res = await POST(storyRequest());
    expect(res.status).toBe(403);
    expect(mockAssertAuthorized).toHaveBeenCalledWith(
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
    // ignoring the write-block, `authorize` returns unauthorized when
    // `customerId` is not in `bridgeScope.customerIds`.
    bridgeOverride.current = {
      bridgeAiceId: BRIDGE_AICE_ID,
      bridgeCustomerIds: [OTHER_CUSTOMER_ID],
    };
    const { HttpError } = await import("@/lib/auth/errors");
    mockAssertAuthorized.mockRejectedValue(new HttpError("Forbidden", 403));
    const { POST } = await import("../story/[storyId]/regenerate/route");
    const res = await POST(storyRequest());
    expect(res.status).toBe(403);
    expect(mockAssertAuthorized).toHaveBeenCalledWith(
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

describe("report regenerate stub", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    authMode.current = "authed";
    bridgeOverride.current = null;
    mockAssertAuthorized.mockResolvedValue(new Set(["reports:create"]));
  });

  it("returns 401 when the request is unauthenticated", async () => {
    authMode.current = "unauthed";
    const { POST } = await import(
      "../report/[period]/[bucketDate]/regenerate/route"
    );
    const res = await POST(reportRequest());
    expect(res.status).toBe(401);
    expect(mockAssertAuthorized).not.toHaveBeenCalled();
  });

  it("returns 403 when the caller is not a member of customer_id", async () => {
    const { HttpError } = await import("@/lib/auth/errors");
    mockAssertAuthorized.mockRejectedValue(new HttpError("Forbidden", 403));
    const { POST } = await import(
      "../report/[period]/[bucketDate]/regenerate/route"
    );
    const res = await POST(reportRequest());
    expect(res.status).toBe(403);
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
    expect(body.period).toBe("DAILY");
    expect(body.bucket_date).toBe("2026-05-27");
    expect(body.variant.tz).toBe("Asia/Tokyo");
  });

  it("returns 403 when the caller lacks reports:create", async () => {
    const { HttpError } = await import("@/lib/auth/errors");
    mockAssertAuthorized.mockRejectedValue(new HttpError("Forbidden", 403));
    const { POST } = await import(
      "../report/[period]/[bucketDate]/regenerate/route"
    );
    const res = await POST(reportRequest());
    expect(res.status).toBe(403);
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

  // Round-24 review item 2: the regex-only shape check let values like
  // `2026-02-31` or `2026-99-99` pass to authorization and 202, locking
  // a surprising contract before Phase 1 casts the path segment to a
  // SQL `date`. The validator must reject impossible calendar dates.
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
    expect(mockAssertAuthorized).not.toHaveBeenCalled();
  });

  it("accepts a real leap-year date (2024-02-29)", async () => {
    const { POST } = await import(
      "../report/[period]/[bucketDate]/regenerate/route"
    );
    const req = new NextRequest(
      new URL(
        `http://localhost:3000/api/customers/${CUSTOMER_ID}/analysis/report/DAILY/2024-02-29/regenerate`,
      ),
      { method: "POST" },
    );
    const res = await POST(req);
    expect(res.status).toBe(202);
  });

  it("authorizes as a write op with no bridge scope for an ordinary session", async () => {
    const { POST } = await import(
      "../report/[period]/[bucketDate]/regenerate/route"
    );
    const res = await POST(reportRequest());
    expect(res.status).toBe(202);
    expect(mockAssertAuthorized).toHaveBeenCalledWith(
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

  it("rejects bridge sessions (writes are blocked in bridge sessions)", async () => {
    bridgeOverride.current = {
      bridgeAiceId: BRIDGE_AICE_ID,
      bridgeCustomerIds: [CUSTOMER_ID],
    };
    const { HttpError } = await import("@/lib/auth/errors");
    mockAssertAuthorized.mockRejectedValue(new HttpError("Forbidden", 403));
    const { POST } = await import(
      "../report/[period]/[bucketDate]/regenerate/route"
    );
    const res = await POST(reportRequest());
    expect(res.status).toBe(403);
    expect(mockAssertAuthorized).toHaveBeenCalledWith(
      expect.anything(),
      "general",
      SELF,
      "reports:create",
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
    bridgeOverride.current = {
      bridgeAiceId: BRIDGE_AICE_ID,
      bridgeCustomerIds: [OTHER_CUSTOMER_ID],
    };
    const { HttpError } = await import("@/lib/auth/errors");
    mockAssertAuthorized.mockRejectedValue(new HttpError("Forbidden", 403));
    const { POST } = await import(
      "../report/[period]/[bucketDate]/regenerate/route"
    );
    const res = await POST(reportRequest());
    expect(res.status).toBe(403);
    expect(mockAssertAuthorized).toHaveBeenCalledWith(
      expect.anything(),
      "general",
      SELF,
      "reports:create",
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
