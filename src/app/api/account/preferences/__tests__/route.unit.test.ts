import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const ACCOUNT_ID = "00000000-0000-0000-0000-000000000001";

// Controls whether each context's session is live. Cookie presence and
// session liveness are independent: a cookie can linger past idle
// timeout / revocation, in which case `withAuth` 401s before the handler.
let generalSessionValid = true;
let adminSessionValid = true;

const mockWithAuth = vi.fn(
  // biome-ignore lint/complexity/noBannedTypes: test mock needs generic callable
  (handler: Function, opts?: { ctx?: "general" | "admin" }) =>
    (req: NextRequest) => {
      const ctx = opts?.ctx ?? "general";
      const valid = ctx === "general" ? generalSessionValid : adminSessionValid;
      if (!valid) {
        return Promise.resolve(
          Response.json({ error: "Unauthorized" }, { status: 401 }),
        );
      }
      return handler(req, {
        accountId: ACCOUNT_ID,
        sessionId: "sess-1",
        authContext: ctx,
        tokenVersion: 1,
        iat: 1000,
        meta: { ipAddress: "127.0.0.1", userAgent: "test" },
        bridgeAiceId: null,
        bridgeCustomerIds: null,
        audit: {},
      });
    },
);

const mockVerifyCsrf = vi.fn((_ctx: "general" | "admin") => null);
vi.mock("@/lib/auth/guards", () => ({
  // biome-ignore lint/complexity/noBannedTypes: test mock needs generic callable
  withAuth: (handler: Function, opts?: { ctx?: "general" | "admin" }) =>
    mockWithAuth(handler, opts),
  verifyOrigin: () => null,
  verifyCsrf: (_req: NextRequest, params: { ctx: "general" | "admin" }) =>
    mockVerifyCsrf(params.ctx),
}));

// Controls which session the dispatcher authorizes. Default: a general
// cookie is present (the common case).
let generalCookie: string | null = "general-token";
let adminCookie: string | null = "admin-token";
vi.mock("@/lib/auth/cookies", () => ({
  getAuthCookie: (ctx: "general" | "admin") =>
    Promise.resolve(ctx === "general" ? generalCookie : adminCookie),
}));

const mockQuery = vi.fn();
vi.mock("@/lib/db/client", () => ({
  getAuthPool: vi.fn(() => ({})),
  query: (...args: unknown[]) => mockQuery(...args),
}));

const mockSetCookie = vi.fn(async (_locale: string) => {});
const mockClearCookie = vi.fn(async () => {});
vi.mock("@/i18n/locale-cookie", () => ({
  setNextLocaleCookie: mockSetCookie,
  clearNextLocaleCookie: mockClearCookie,
}));

async function loadPatch() {
  const mod = await import("../route");
  return mod.PATCH;
}

function patch(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/account/preferences", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

beforeEach(() => {
  mockQuery.mockReset();
  mockSetCookie.mockReset();
  mockClearCookie.mockReset();
  mockVerifyCsrf.mockClear();
  generalCookie = "general-token";
  adminCookie = "admin-token";
  generalSessionValid = true;
  adminSessionValid = true;
  mockQuery.mockResolvedValue([{ locale: "en", timezone: null }]);
});

describe("PATCH /api/account/preferences", () => {
  it("rejects an invalid locale", async () => {
    const res = await (await loadPatch())(patch({ locale: "fr" }));
    expect(res.status).toBe(400);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it("rejects an invalid timezone", async () => {
    const res = await (await loadPatch())(patch({ timezone: "Not/AZone" }));
    expect(res.status).toBe(400);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it("rejects a body with no updatable fields", async () => {
    const res = await (await loadPatch())(patch({}));
    expect(res.status).toBe(400);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it("rejects malformed JSON", async () => {
    const res = await (await loadPatch())(patch("{ not json"));
    expect(res.status).toBe(400);
  });

  it("persists a valid locale and mirrors the cookie", async () => {
    mockQuery.mockResolvedValue([{ locale: "ko", timezone: null }]);
    const res = await (await loadPatch())(patch({ locale: "ko" }));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ locale: "ko", timezone: null });

    const [, sql, params] = mockQuery.mock.calls[0];
    expect(sql).toContain("UPDATE accounts SET");
    expect(params).toEqual(["ko", ACCOUNT_ID]);
    expect(mockSetCookie).toHaveBeenCalledWith("ko");
  });

  it("persists a valid timezone without touching the cookie", async () => {
    mockQuery.mockResolvedValue([{ locale: null, timezone: "Asia/Seoul" }]);
    const res = await (await loadPatch())(patch({ timezone: "Asia/Seoul" }));
    expect(res.status).toBe(200);
    const [, , params] = mockQuery.mock.calls[0];
    expect(params).toEqual(["Asia/Seoul", ACCOUNT_ID]);
    expect(mockSetCookie).not.toHaveBeenCalled();
    expect(mockClearCookie).not.toHaveBeenCalled();
  });

  it("clears the cookie when locale is set to null", async () => {
    mockQuery.mockResolvedValue([{ locale: null, timezone: null }]);
    const res = await (await loadPatch())(patch({ locale: null }));
    expect(res.status).toBe(200);
    expect(mockClearCookie).toHaveBeenCalledTimes(1);
    expect(mockSetCookie).not.toHaveBeenCalled();
  });

  it("clears the timezone when set to null", async () => {
    mockQuery.mockResolvedValue([{ locale: null, timezone: null }]);
    const res = await (await loadPatch())(patch({ timezone: null }));
    expect(res.status).toBe(200);
    const [, , params] = mockQuery.mock.calls[0];
    expect(params).toEqual([null, ACCOUNT_ID]);
  });

  it("updates both fields together", async () => {
    mockQuery.mockResolvedValue([{ locale: "en", timezone: "UTC" }]);
    const res = await (await loadPatch())(
      patch({ locale: "en", timezone: "UTC" }),
    );
    expect(res.status).toBe(200);
    const [, sql, params] = mockQuery.mock.calls[0];
    expect(sql).toContain("locale = $1");
    expect(sql).toContain("timezone = $2");
    expect(params).toEqual(["en", "UTC", ACCOUNT_ID]);
  });

  it("returns 404 when the account row is missing", async () => {
    mockQuery.mockResolvedValue([]);
    const res = await (await loadPatch())(patch({ locale: "en" }));
    expect(res.status).toBe(404);
  });

  it("authorizes the general session and verifies its CSRF token", async () => {
    const res = await (await loadPatch())(patch({ locale: "en" }));
    expect(res.status).toBe(200);
    expect(mockVerifyCsrf).toHaveBeenCalledWith("general");
  });

  it("falls back to the admin session when no general cookie is present", async () => {
    // An admin-only session (e.g. toggling the switcher in the admin
    // header) must still persist — it should not 401 (#387, #410 review).
    generalCookie = null;
    const res = await (await loadPatch())(patch({ locale: "ko" }));
    expect(res.status).toBe(200);
    expect(mockVerifyCsrf).toHaveBeenCalledWith("admin");
    const [, , params] = mockQuery.mock.calls[0];
    expect(params).toEqual(["ko", ACCOUNT_ID]);
  });

  it("falls through to admin when a lingering general cookie's session is stale", async () => {
    // Common "working in admin after the general session idled out" case
    // (#410 Round 2): the general cookie is still present but its session
    // is no longer live, so the general handler 401s. The dispatcher must
    // fall through to the live admin session rather than surfacing the 401.
    generalCookie = "general-token";
    adminCookie = "admin-token";
    generalSessionValid = false;
    adminSessionValid = true;
    const res = await (await loadPatch())(patch({ locale: "ko" }));
    expect(res.status).toBe(200);
    expect(mockVerifyCsrf).toHaveBeenCalledWith("admin");
    const [, , params] = mockQuery.mock.calls[0];
    expect(params).toEqual(["ko", ACCOUNT_ID]);
  });

  it("returns 401 when the general session is stale and there is no admin session", async () => {
    generalCookie = "general-token";
    adminCookie = null;
    generalSessionValid = false;
    const res = await (await loadPatch())(patch({ locale: "ko" }));
    expect(res.status).toBe(401);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it("does not fall through to admin on a non-401 general response", async () => {
    // A live general session that returns a 400 (validation) must own the
    // request — the dispatcher must not retry under the admin context.
    generalSessionValid = true;
    const res = await (await loadPatch())(patch({ locale: "fr" }));
    expect(res.status).toBe(400);
    expect(mockVerifyCsrf).toHaveBeenCalledWith("general");
    expect(mockVerifyCsrf).not.toHaveBeenCalledWith("admin");
  });
});
