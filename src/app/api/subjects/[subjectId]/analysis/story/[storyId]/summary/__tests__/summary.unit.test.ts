import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mockAuthorize = vi.fn();
const mockConnect = vi.fn(() => ({
  query: vi.fn(),
  release: vi.fn(),
}));
const mockCustomerQuery = vi.fn();

const SELF = "00000000-0000-0000-0000-000000000099";
const CUSTOMER_ID = "c0000000-0000-0000-0000-000000000001";

const authMode = { current: "authed" as "authed" | "unauthed" };

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
      bridgeAiceId: null,
      bridgeCustomerIds: null,
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
  getCustomerRuntimePool: () => ({ query: mockCustomerQuery }),
}));

function summaryRequest(): NextRequest {
  return new NextRequest(
    new URL(
      `http://localhost:3000/api/subjects/${CUSTOMER_ID}/analysis/story/12345/summary`,
    ),
  );
}

describe("story summary endpoint", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    authMode.current = "authed";
    mockAuthorize.mockResolvedValue({
      authorized: true,
      permissions: new Set(["analyses:read"]),
    });
  });

  it("returns {exists: false} when no result row exists", async () => {
    mockCustomerQuery.mockResolvedValueOnce({ rows: [] });
    const { GET } = await import("../route");
    const res = await GET(summaryRequest());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ exists: false });
  });

  it("returns the latest non-superseded result for the default variant", async () => {
    mockCustomerQuery.mockResolvedValueOnce({
      rows: [
        {
          priority_tier: "HIGH",
          severity_score: 0.7,
          likelihood_score: 0.55,
        },
      ],
    });
    const { GET } = await import("../route");
    const res = await GET(summaryRequest());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      exists: true,
      priority_tier: "HIGH",
      severity_score: 0.7,
      likelihood_score: 0.55,
      score_kind: "leaf",
      link: `/subjects/${CUSTOMER_ID}/analysis/story/12345`,
    });
  });

  it("returns 401 when unauthenticated", async () => {
    authMode.current = "unauthed";
    const { GET } = await import("../route");
    const res = await GET(summaryRequest());
    expect(res.status).toBe(401);
  });

  it("returns 404 story_not_found when the caller is not a member", async () => {
    // Non-member: `authorizeGeneral` returns `{authorized: false}`
    // with no `permissions` field. Existence-hiding policy collapses
    // this to 404 (RFC 0002 amendment, #333).
    mockAuthorize.mockResolvedValue({ authorized: false });
    const { GET } = await import("../route");
    const res = await GET(summaryRequest());
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("story_not_found");
  });

  it("returns 403 when the caller is a member but lacks analyses:read", async () => {
    // Member: `authorizeGeneral` returns `{authorized: false,
    // permissions: Set<...>}` when the caller holds membership but
    // not the required permission key. Surfaces as a precise 403.
    mockAuthorize.mockResolvedValue({
      authorized: false,
      permissions: new Set(["analyses:notify"]),
    });
    const { GET } = await import("../route");
    const res = await GET(summaryRequest());
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe("Forbidden");
  });

  it("returns 403 bridge_not_allowed for a bridge session blocked from the endpoint", async () => {
    mockAuthorize.mockResolvedValue({
      authorized: false,
      reason: "bridge_not_allowed",
    });
    const { GET } = await import("../route");
    const res = await GET(summaryRequest());
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe("bridge_not_allowed");
  });
});
