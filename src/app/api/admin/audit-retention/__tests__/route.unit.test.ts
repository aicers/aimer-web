import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockPurge = vi.fn();
const mockAuditMeta: Record<string, unknown> = {};

vi.mock("@/lib/audit/retention", () => ({
  purgeExpiredAuditLogs: (...args: unknown[]) => mockPurge(...args),
}));

vi.mock("@/lib/auth/guards", () => ({
  // biome-ignore lint/complexity/noBannedTypes: test mock needs generic callable
  withAuth: (handler: Function, _opts?: unknown) => (req: NextRequest) =>
    handler(req, {
      accountId: "acct-1",
      sessionId: "sess-1",
      authContext: "admin",
      tokenVersion: 1,
      iat: 1000,
      meta: { ipAddress: "127.0.0.1", userAgent: "test" },
      bridgeAiceId: null,
      bridgeCustomerIds: null,
      audit: mockAuditMeta,
    }),
  verifyOrigin: () => null,
  verifyCsrf: () => null,
}));

vi.mock("@/lib/db/client", () => ({
  getMigrationAuditPool: vi.fn(() => ({})),
}));

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("POST /api/admin/audit-retention", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    for (const k of Object.keys(mockAuditMeta)) {
      delete mockAuditMeta[k];
    }
    mockPurge.mockResolvedValue(10);
  });

  async function callPOST(body: unknown) {
    const { POST } = await import("../route");
    const req = new NextRequest(
      "http://localhost:3000/api/admin/audit-retention",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          origin: "http://localhost:3000",
        },
        body: JSON.stringify(body),
      },
    );
    return POST(req);
  }

  it("purges with default retention and returns deleted count", async () => {
    const res = await callPOST({});
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.deleted).toBe(10);
    expect(mockPurge).toHaveBeenCalledWith(expect.anything(), undefined);
  });

  it("accepts custom retentionDays", async () => {
    mockPurge.mockResolvedValue(5);

    const res = await callPOST({ retentionDays: 90 });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.deleted).toBe(5);
    expect(mockPurge).toHaveBeenCalledWith(expect.anything(), 90);
  });

  it("sets audit metadata for guard-level emission", async () => {
    await callPOST({ retentionDays: 30 });

    expect(mockAuditMeta.details).toEqual({
      retentionDays: 30,
      deleted: 10,
    });
  });

  it("sets default retentionDays=365 in audit metadata when omitted", async () => {
    await callPOST({});

    expect(mockAuditMeta.details).toEqual({
      retentionDays: 365,
      deleted: 10,
    });
  });

  it("returns 400 for non-integer retentionDays", async () => {
    const res = await callPOST({ retentionDays: 1.5 });
    expect(res.status).toBe(400);
    expect(mockPurge).not.toHaveBeenCalled();
  });

  it("returns 400 for retentionDays < 1", async () => {
    const res = await callPOST({ retentionDays: 0 });
    expect(res.status).toBe(400);
    expect(mockPurge).not.toHaveBeenCalled();
  });

  it("returns 400 for non-number retentionDays", async () => {
    const res = await callPOST({ retentionDays: "abc" });
    expect(res.status).toBe(400);
    expect(mockPurge).not.toHaveBeenCalled();
  });

  it("returns 400 for invalid JSON", async () => {
    const { POST } = await import("../route");
    const req = new NextRequest(
      "http://localhost:3000/api/admin/audit-retention",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          origin: "http://localhost:3000",
        },
        body: "not-json",
      },
    );
    const res = await POST(req);
    expect(res.status).toBe(400);
    expect(mockPurge).not.toHaveBeenCalled();
  });
});
