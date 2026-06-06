import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const SELF_ACCOUNT_ID = "00000000-0000-0000-0000-000000000099";

const mockAssertAuthorized = vi.fn();
const mockRevoke = vi.fn();
const mockConnect = vi.fn(() => ({ query: vi.fn(), release: vi.fn() }));
const mockVerifyOrigin = vi.fn<() => Response | null>(() => null);
const mockVerifyCsrf = vi.fn<() => Response | null>(() => null);

const mockWithAuth = vi.fn(
  // biome-ignore lint/complexity/noBannedTypes: test mock needs generic callable
  (handler: Function) => (req: NextRequest) =>
    handler(req, {
      accountId: SELF_ACCOUNT_ID,
      sessionId: "sess-1",
      authContext: "admin",
      tokenVersion: 1,
      iat: 1000,
      meta: { ipAddress: "127.0.0.1", userAgent: "test" },
      bridgeAiceId: null,
      bridgeCustomerIds: null,
      audit: {},
    }),
);

vi.mock("@/lib/auth/guards", () => ({
  // biome-ignore lint/complexity/noBannedTypes: test mock needs generic callable
  withAuth: (handler: Function, _opts?: unknown) => mockWithAuth(handler),
  verifyOrigin: () => mockVerifyOrigin(),
  verifyCsrf: () => mockVerifyCsrf(),
}));

vi.mock("@/lib/auth/authorization", () => ({
  assertAuthorized: (...args: unknown[]) => mockAssertAuthorized(...args),
}));

vi.mock("@/lib/db/client", () => ({
  getAuthPool: vi.fn(() => ({ connect: mockConnect })),
  withTransaction: vi.fn(
    (_pool: unknown, fn: (client: { query: typeof vi.fn }) => unknown) =>
      fn({ query: vi.fn() }),
  ),
}));

vi.mock("@/lib/auth/analyst-invitations", () => ({
  revokeAnalystInvitation: (...args: unknown[]) => mockRevoke(...args),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const BASE = "http://localhost:3000/api/admin/analysts/invitations";
const VALID_ID = "a0000000-0000-0000-0000-000000000001";

function makeDelete(id: string): NextRequest {
  return new NextRequest(new URL(`${BASE}/${id}`), { method: "DELETE" });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockAssertAuthorized.mockResolvedValue(new Set());
  mockVerifyOrigin.mockReturnValue(null);
  mockVerifyCsrf.mockReturnValue(null);
});

// ---------------------------------------------------------------------------
// DELETE
// ---------------------------------------------------------------------------

describe("DELETE /api/admin/analysts/invitations/[id]", () => {
  it("requires analysts:write", async () => {
    mockRevoke.mockResolvedValue({ id: VALID_ID, status: "revoked" });
    const { DELETE } = await import("../route");
    await DELETE(makeDelete(VALID_ID));
    expect(mockAssertAuthorized).toHaveBeenCalledWith(
      expect.anything(),
      "admin",
      SELF_ACCOUNT_ID,
      "analysts:write",
    );
  });

  it("returns 200 { id, status: 'revoked' } on success", async () => {
    mockRevoke.mockResolvedValue({ id: VALID_ID, status: "revoked" });
    const { DELETE } = await import("../route");
    const res = await DELETE(makeDelete(VALID_ID));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body).toEqual({ id: VALID_ID, status: "revoked" });
  });

  it("returns 404 not_found for a malformed id (no DB work)", async () => {
    const { DELETE } = await import("../route");
    const res = await DELETE(makeDelete("not-a-uuid"));
    const body = await res.json();
    expect(res.status).toBe(404);
    expect(body.error).toBe("not_found");
    expect(mockRevoke).not.toHaveBeenCalled();
  });

  it("maps HttpError codes from the lib (409 already_consumed)", async () => {
    const { HttpError } = await import("@/lib/auth/errors");
    mockRevoke.mockRejectedValue(new HttpError("already_consumed", 409));
    const { DELETE } = await import("../route");
    const res = await DELETE(makeDelete(VALID_ID));
    const body = await res.json();
    expect(res.status).toBe(409);
    expect(body.error).toBe("already_consumed");
  });

  it("maps 404 not_found from the lib", async () => {
    const { HttpError } = await import("@/lib/auth/errors");
    mockRevoke.mockRejectedValue(new HttpError("not_found", 404));
    const { DELETE } = await import("../route");
    const res = await DELETE(makeDelete(VALID_ID));
    expect(res.status).toBe(404);
  });

  it("returns 403 when origin verification fails (before any DB work)", async () => {
    mockVerifyOrigin.mockReturnValue(
      Response.json({ error: "Origin mismatch" }, { status: 403 }),
    );
    const { DELETE } = await import("../route");
    const res = await DELETE(makeDelete(VALID_ID));
    expect(res.status).toBe(403);
    expect(mockAssertAuthorized).not.toHaveBeenCalled();
    expect(mockRevoke).not.toHaveBeenCalled();
  });

  it("returns 403 when CSRF verification fails (before any DB work)", async () => {
    mockVerifyCsrf.mockReturnValue(
      Response.json({ error: "CSRF validation failed" }, { status: 403 }),
    );
    const { DELETE } = await import("../route");
    const res = await DELETE(makeDelete(VALID_ID));
    expect(res.status).toBe(403);
    expect(mockRevoke).not.toHaveBeenCalled();
  });
});
