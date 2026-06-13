// RFC 0003 self-fetch scheduler (3b, #570) — schedule route tests.
//
// `PUT /api/admin/ti-feed/schedule`: admin-gated (origin + CSRF +
// `ti-feed:write` via `setSelfFetchSchedule`), self-fetch-mode-only (404
// otherwise). The schedule write itself is mocked — DB round-trip + audit are
// covered by the DB test.

import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const SELF_ACCOUNT_ID = "00000000-0000-0000-0000-000000000099";

const mockSetSchedule = vi.fn();
let mockVerifyOrigin: () => Response | null = () => null;
let mockVerifyCsrf: () => Response | null = () => null;

vi.mock("@/lib/auth/guards", () => ({
  // biome-ignore lint/complexity/noBannedTypes: test mock needs generic callable
  withAuth: (handler: Function) => (req: NextRequest) =>
    handler(req, {
      accountId: SELF_ACCOUNT_ID,
      sessionId: "sess-1",
      authContext: "admin",
      iat: 1000,
      meta: { ipAddress: "127.0.0.1", userAgent: "test" },
    }),
  verifyOrigin: () => mockVerifyOrigin(),
  verifyCsrf: () => mockVerifyCsrf(),
}));

vi.mock("@/lib/db/client", () => ({
  getAuthPool: vi.fn(() => ({})),
  // Run the callback with a fake client.
  withTransaction: vi.fn(
    async (_pool: unknown, fn: (client: unknown) => unknown) =>
      fn({ query: vi.fn() }),
  ),
}));

vi.mock("@/lib/analysis/enrichment/feed-schedule", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/lib/analysis/enrichment/feed-schedule")
    >();
  return {
    ...actual,
    setSelfFetchSchedule: (...args: unknown[]) => mockSetSchedule(...args),
  };
});

const SCHEDULE_URL = "http://localhost:3000/api/admin/ti-feed/schedule";

function makeReq(body?: unknown): NextRequest {
  return new NextRequest(new URL(SCHEDULE_URL), {
    method: "PUT",
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.TI_FEED_MODE = "self-fetch";
  mockVerifyOrigin = () => null;
  mockVerifyCsrf = () => null;
  mockSetSchedule.mockResolvedValue({ enabled: true, intervalMs: 600000 });
});

describe("PUT /api/admin/ti-feed/schedule", () => {
  it("404s outside self-fetch mode", async () => {
    process.env.TI_FEED_MODE = "manual-upload";
    const { PUT } = await import("../schedule/route");
    const res = await PUT(makeReq({ enabled: true }));
    expect(res.status).toBe(404);
    expect(mockSetSchedule).not.toHaveBeenCalled();
  });

  it("enforces verifyOrigin", async () => {
    mockVerifyOrigin = () => Response.json({ error: "bad" }, { status: 403 });
    const { PUT } = await import("../schedule/route");
    const res = await PUT(makeReq({ enabled: true }));
    expect(res.status).toBe(403);
    expect(mockSetSchedule).not.toHaveBeenCalled();
  });

  it("enforces verifyCsrf", async () => {
    mockVerifyCsrf = () => Response.json({ error: "bad" }, { status: 403 });
    const { PUT } = await import("../schedule/route");
    const res = await PUT(makeReq({ enabled: true }));
    expect(res.status).toBe(403);
    expect(mockSetSchedule).not.toHaveBeenCalled();
  });

  it("400s for an invalid JSON body", async () => {
    const { PUT } = await import("../schedule/route");
    const res = await PUT(makeReq("not json"));
    expect(res.status).toBe(400);
    expect(mockSetSchedule).not.toHaveBeenCalled();
  });

  it("403s without ti-feed:write (authz inside the setter)", async () => {
    const { HttpError } = await import("@/lib/auth/errors");
    mockSetSchedule.mockRejectedValue(new HttpError("Forbidden", 403));
    const { PUT } = await import("../schedule/route");
    const res = await PUT(makeReq({ enabled: true }));
    expect(res.status).toBe(403);
  });

  it("400s for a malformed schedule (setter validation)", async () => {
    const { HttpError } = await import("@/lib/auth/errors");
    mockSetSchedule.mockRejectedValue(
      new HttpError("enabled is required and must be a boolean", 400),
    );
    const { PUT } = await import("../schedule/route");
    const res = await PUT(makeReq({ enabled: "yes" }));
    expect(res.status).toBe(400);
  });

  it("saves the schedule and returns it", async () => {
    const { PUT } = await import("../schedule/route");
    const res = await PUT(makeReq({ enabled: true, intervalMs: 600000 }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      schedule: { enabled: true, intervalMs: 600000 },
    });
    expect(mockSetSchedule).toHaveBeenCalledWith(
      expect.anything(),
      SELF_ACCOUNT_ID,
      { enabled: true, intervalMs: 600000 },
      { ipAddress: "127.0.0.1", sid: "sess-1" },
    );
  });
});
