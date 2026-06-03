// #388 (L2 phase 2) — read-only on-demand report-language job status route.
//
// Locks: 401 unauthenticated, 404 non-member (existence-hiding), 403
// member-without-reports:read, the locale-code `?lang=` → enum mapping for
// the job lookup, and the {status} shape (job status or null).

import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mockAuthorize = vi.fn();
const mockClientQuery = vi.fn();
const mockConnect = vi.fn(() => ({
  query: mockClientQuery,
  release: vi.fn(),
}));

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

function statusRequest(query = "?tz=Asia/Seoul&lang=ko"): NextRequest {
  return new NextRequest(
    new URL(
      `http://localhost:3000/api/customers/${CUSTOMER_ID}/analysis/report/DAILY/2026-05-26/language-status${query}`,
    ),
  );
}

describe("report language-status endpoint", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    authMode.current = "authed";
    mockAuthorize.mockResolvedValue({
      authorized: true,
      permissions: new Set(["reports:read"]),
    });
    // Default: a queued job row for the requested variant.
    mockClientQuery.mockResolvedValue({ rows: [{ status: "queued" }] });
  });

  it("returns 401 when unauthenticated", async () => {
    authMode.current = "unauthed";
    const { GET } = await import("../route");
    const res = await GET(statusRequest());
    expect(res.status).toBe(401);
  });

  it("returns 404 for a non-member (existence-hiding)", async () => {
    mockAuthorize.mockResolvedValue({ authorized: false });
    const { GET } = await import("../route");
    const res = await GET(statusRequest());
    expect(res.status).toBe(404);
  });

  it("returns 403 for a member lacking reports:read", async () => {
    mockAuthorize.mockResolvedValue({
      authorized: false,
      permissions: new Set(["analyses:read"]),
    });
    const { GET } = await import("../route");
    const res = await GET(statusRequest());
    expect(res.status).toBe(403);
  });

  it("maps ?lang=ko to the KOREAN enum and returns the job status", async () => {
    const { GET } = await import("../route");
    const res = await GET(statusRequest());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "queued" });
    // The job lookup queried the KOREAN enum mapped from the `ko` locale.
    expect(mockClientQuery.mock.calls.at(-1)?.[1]).toContain("KOREAN");
  });

  it("returns {status: null} when no job row exists", async () => {
    mockClientQuery.mockResolvedValue({ rows: [] });
    const { GET } = await import("../route");
    const res = await GET(statusRequest());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: null });
  });

  it("falls back to the English baseline for an absent ?lang", async () => {
    mockClientQuery.mockResolvedValue({ rows: [{ status: "processing" }] });
    const { GET } = await import("../route");
    const res = await GET(statusRequest("?tz=Asia/Seoul"));
    expect(res.status).toBe(200);
    expect(mockClientQuery.mock.calls.at(-1)?.[1]).toContain("ENGLISH");
  });
});
