import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const ACCOUNT_ID = "00000000-0000-0000-0000-000000000001";

const mockWithAuth = vi.fn(
  // biome-ignore lint/complexity/noBannedTypes: test mock needs generic callable
  (handler: Function) => (req: NextRequest) =>
    handler(req, {
      accountId: ACCOUNT_ID,
      sessionId: "sess-1",
      authContext: "general",
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
  verifyOrigin: () => null,
  verifyCsrf: () => null,
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
});
