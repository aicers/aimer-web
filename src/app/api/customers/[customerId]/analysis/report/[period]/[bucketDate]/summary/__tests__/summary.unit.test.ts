// RFC 0002 Phase 2 (#297) — periodic report summary API tests.
//
// Locks: 401 unauthenticated, 404 non-member (existence-hiding), 403
// member-without-reports:read, exists:false when no row, exists:true
// with score_kind="aggregate" and an UPPERCASE customer-scoped link,
// and the path-case lock (lowercase period → 404/invalid path is a UI
// concern; here the API only emits the uppercase link).

import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mockAuthorize = vi.fn();
const mockClientQuery = vi.fn();
const mockConnect = vi.fn(() => ({
  query: mockClientQuery,
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

function summaryRequest(
  period = "DAILY",
  bucketDate = "2026-05-26",
  query = "?tz=Asia/Seoul",
): NextRequest {
  return new NextRequest(
    new URL(
      `http://localhost:3000/api/customers/${CUSTOMER_ID}/analysis/report/${period}/${bucketDate}/summary${query}`,
    ),
  );
}

describe("periodic report summary endpoint", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    authMode.current = "authed";
    mockAuthorize.mockResolvedValue({
      authorized: true,
      permissions: new Set(["reports:read"]),
    });
  });

  it("returns 401 when unauthenticated", async () => {
    authMode.current = "unauthed";
    const { GET } = await import("../route");
    const res = await GET(summaryRequest());
    expect(res.status).toBe(401);
  });

  it("returns 404 report_state_not_found for a non-member", async () => {
    mockAuthorize.mockResolvedValue({ authorized: false });
    const { GET } = await import("../route");
    const res = await GET(summaryRequest());
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("report_state_not_found");
  });

  it("returns 403 Forbidden for a member lacking reports:read", async () => {
    mockAuthorize.mockResolvedValue({
      authorized: false,
      permissions: new Set(["analyses:read"]),
    });
    const { GET } = await import("../route");
    const res = await GET(summaryRequest());
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe("Forbidden");
  });

  it("returns {exists: false} when no result row exists", async () => {
    mockCustomerQuery.mockResolvedValueOnce({ rows: [] });
    const { GET } = await import("../route");
    const res = await GET(summaryRequest());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ exists: false });
  });

  it("returns the aggregate summary with an uppercase customer-scoped link", async () => {
    mockCustomerQuery.mockResolvedValueOnce({
      rows: [
        {
          priority_tier: "HIGH",
          aggregate_severity_score: 0.85,
          aggregate_likelihood_score: 0.7,
        },
      ],
    });
    const { GET } = await import("../route");
    const res = await GET(summaryRequest("DAILY", "2026-05-26"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      exists: true,
      priority_tier: "HIGH",
      severity_score: 0.85,
      likelihood_score: 0.7,
      score_kind: "aggregate",
      link: `/customers/${CUSTOMER_ID}/analysis/reports/DAILY/2026-05-26`,
    });
    // The period in the link is UPPERCASE (case lock) — never `/daily/`.
    expect(body.link).not.toContain("/daily/");
  });

  it("falls back to the customer timezone when ?tz is absent", async () => {
    mockClientQuery.mockResolvedValueOnce({
      rows: [{ timezone: "Asia/Seoul" }],
    });
    mockCustomerQuery.mockResolvedValueOnce({ rows: [] });
    const { GET } = await import("../route");
    const res = await GET(summaryRequest("DAILY", "2026-05-26", ""));
    expect(res.status).toBe(200);
    // The customer-pool query was issued with the looked-up tz.
    const call = mockCustomerQuery.mock.calls[0];
    expect(call[1]).toContain("Asia/Seoul");
  });

  it("returns 400 invalid_report_path for LIVE with a non-epoch bucket", async () => {
    const { GET } = await import("../route");
    const res = await GET(summaryRequest("LIVE", "2026-05-26"));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("invalid_report_path");
  });
});
