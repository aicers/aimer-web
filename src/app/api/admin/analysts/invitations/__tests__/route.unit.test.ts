import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const SELF_ACCOUNT_ID = "00000000-0000-0000-0000-000000000099";

const mockAssertAuthorized = vi.fn();
const mockCreateAnalystInvitation = vi.fn();
const mockListPending = vi.fn();
const mockDeliver = vi.fn();
const mockConnect = vi.fn(() => ({ query: vi.fn(), release: vi.fn() }));
const mockVerifyOrigin = vi.fn<() => Response | null>(() => null);
const mockVerifyCsrf = vi.fn<() => Response | null>(() => null);

/** Captured `after()` callbacks, invoked manually by the tests. */
let afterTasks: Array<() => Promise<void>>;

vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>();
  return {
    ...actual,
    after: (task: () => Promise<void>) => {
      afterTasks.push(task);
    },
  };
});

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
  createAnalystInvitation: (...args: unknown[]) =>
    mockCreateAnalystInvitation(...args),
  listPendingAnalystInvitations: (...args: unknown[]) =>
    mockListPending(...args),
  deliverAnalystInvitation: (...args: unknown[]) => mockDeliver(...args),
}));

vi.mock("@/lib/auth/canonical-origin", () => ({
  canonicalOrigin: () => "https://example.test",
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const BASE_URL = "http://localhost:3000/api/admin/analysts/invitations";
const CUST_A = "c0000000-0000-0000-0000-000000000001";

function makeGet(): NextRequest {
  return new NextRequest(new URL(BASE_URL), { method: "GET" });
}

function makePost(body: unknown): NextRequest {
  return new NextRequest(new URL(BASE_URL), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function flushAfter(): Promise<void> {
  for (const task of afterTasks) await task();
}

beforeEach(() => {
  vi.clearAllMocks();
  afterTasks = [];
  mockAssertAuthorized.mockResolvedValue(new Set());
  mockVerifyOrigin.mockReturnValue(null);
  mockVerifyCsrf.mockReturnValue(null);
});

// ---------------------------------------------------------------------------
// GET
// ---------------------------------------------------------------------------

describe("GET /api/admin/analysts/invitations", () => {
  it("requires analysts:read", async () => {
    mockListPending.mockResolvedValue([]);
    const { GET } = await import("../route");
    await GET(makeGet());
    expect(mockAssertAuthorized).toHaveBeenCalledWith(
      expect.anything(),
      "admin",
      SELF_ACCOUNT_ID,
      "analysts:read",
    );
  });

  it("returns 403 when authorization fails", async () => {
    const { HttpError } = await import("@/lib/auth/errors");
    mockAssertAuthorized.mockRejectedValue(new HttpError("Forbidden", 403));
    const { GET } = await import("../route");
    const res = await GET(makeGet());
    expect(res.status).toBe(403);
  });

  it("returns the pending invitations", async () => {
    const invitations = [
      {
        id: "i1",
        email: "a@b.com",
        customerIds: [CUST_A],
        invitedBy: SELF_ACCOUNT_ID,
        expiresAt: "2026-01-01T00:00:00.000Z",
      },
    ];
    mockListPending.mockResolvedValue(invitations);
    const { GET } = await import("../route");
    const res = await GET(makeGet());
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.invitations).toEqual(invitations);
  });
});

// ---------------------------------------------------------------------------
// POST
// ---------------------------------------------------------------------------

describe("POST /api/admin/analysts/invitations", () => {
  const created = {
    id: "i1",
    email: "a@b.com",
    customerIds: [CUST_A],
    expiresAt: new Date("2026-01-01T00:00:00.000Z"),
    refreshed: false,
    token: "raw-token",
    customerNames: ["Customer A"],
  };

  it("requires analysts:write", async () => {
    mockCreateAnalystInvitation.mockResolvedValue(created);
    const { POST } = await import("../route");
    await POST(makePost({ email: "a@b.com", customerIds: [CUST_A] }));
    expect(mockAssertAuthorized).toHaveBeenCalledWith(
      expect.anything(),
      "admin",
      SELF_ACCOUNT_ID,
      "analysts:write",
    );
  });

  it("returns 201 with camelCase body and never leaks the token", async () => {
    mockCreateAnalystInvitation.mockResolvedValue(created);
    const { POST } = await import("../route");
    const res = await POST(
      makePost({ email: "a@b.com", customerIds: [CUST_A] }),
    );
    const body = await res.json();
    expect(res.status).toBe(201);
    expect(body).toEqual({
      id: "i1",
      email: "a@b.com",
      customerIds: [CUST_A],
      expiresAt: "2026-01-01T00:00:00.000Z",
      refreshed: false,
    });
    expect(JSON.stringify(body)).not.toContain("raw-token");
  });

  it("schedules email delivery + audit via after()", async () => {
    mockCreateAnalystInvitation.mockResolvedValue(created);
    mockDeliver.mockResolvedValue(undefined);
    const { POST } = await import("../route");
    await POST(makePost({ email: "a@b.com", customerIds: [CUST_A] }));

    // Delivery is deferred — not called during the request.
    expect(mockDeliver).not.toHaveBeenCalled();
    await flushAfter();
    expect(mockDeliver).toHaveBeenCalledTimes(1);
    const arg = mockDeliver.mock.calls[0][0];
    expect(arg).toMatchObject({
      invitationId: "i1",
      token: "raw-token",
      refreshed: false,
      customerIds: [CUST_A],
    });
  });

  it("returns 400 on invalid JSON", async () => {
    const { POST } = await import("../route");
    const req = new NextRequest(new URL(BASE_URL), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not json",
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it("returns 400 when email is not a string", async () => {
    const { POST } = await import("../route");
    const res = await POST(makePost({ customerIds: [CUST_A] }));
    const body = await res.json();
    expect(res.status).toBe(400);
    expect(body.error).toBe("invalid_email");
  });

  it("returns 400 when customerIds is not an array", async () => {
    const { POST } = await import("../route");
    const res = await POST(makePost({ email: "a@b.com", customerIds: "x" }));
    const body = await res.json();
    expect(res.status).toBe(400);
    expect(body.error).toBe("invalid_customer_ids");
  });

  it("propagates HttpError codes from the lib (e.g. 409 already_assigned)", async () => {
    const { HttpError } = await import("@/lib/auth/errors");
    mockCreateAnalystInvitation.mockRejectedValue(
      new HttpError("already_assigned", 409),
    );
    const { POST } = await import("../route");
    const res = await POST(
      makePost({ email: "a@b.com", customerIds: [CUST_A] }),
    );
    const body = await res.json();
    expect(res.status).toBe(409);
    expect(body.error).toBe("already_assigned");
  });

  it("returns 403 when origin verification fails (before any DB work)", async () => {
    mockVerifyOrigin.mockReturnValue(
      Response.json({ error: "Origin mismatch" }, { status: 403 }),
    );
    const { POST } = await import("../route");
    const res = await POST(
      makePost({ email: "a@b.com", customerIds: [CUST_A] }),
    );
    expect(res.status).toBe(403);
    expect(mockAssertAuthorized).not.toHaveBeenCalled();
    expect(mockCreateAnalystInvitation).not.toHaveBeenCalled();
  });

  it("returns 403 when CSRF verification fails (before any DB work)", async () => {
    mockVerifyCsrf.mockReturnValue(
      Response.json({ error: "CSRF validation failed" }, { status: 403 }),
    );
    const { POST } = await import("../route");
    const res = await POST(
      makePost({ email: "a@b.com", customerIds: [CUST_A] }),
    );
    expect(res.status).toBe(403);
    expect(mockCreateAnalystInvitation).not.toHaveBeenCalled();
  });
});
