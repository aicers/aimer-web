import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PendingInvitation } from "@/lib/auth/invitation-management";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const listPendingInvitationsMock = vi.fn<() => Promise<PendingInvitation[]>>();
const revokeInvitationMock = vi.fn<() => Promise<void>>();

vi.mock("@/lib/auth/invitation-management", () => ({
  listPendingInvitations: () => listPendingInvitationsMock(),
  revokeInvitation: () => revokeInvitationMock(),
}));

vi.mock("@/lib/auth/invitations", () => ({
  createInvitation: vi.fn(),
}));

vi.mock("@/lib/auth/audit-stub", () => ({
  auditLog: vi.fn(async () => {}),
}));

vi.mock("@/lib/email/invitation", () => ({
  sendInvitationEmail: vi.fn(async () => {}),
}));

vi.mock("@/lib/db/client", () => ({
  getAuthPool: vi.fn(() => ({})),
  // biome-ignore lint/complexity/noBannedTypes: test mock needs generic callable
  withTransaction: vi.fn(async (_pool: unknown, fn: Function) => fn({})),
}));

// Mock withAuth to bypass authentication and inject test auth context
vi.mock("@/lib/auth/guards", () => ({
  withAuth: vi.fn(
    (handler: (...args: unknown[]) => Promise<Response>) =>
      (req: NextRequest) =>
        handler(req, {
          accountId: "account-001",
          sessionId: "session-001",
          authContext: "general",
          tokenVersion: 1,
          iat: 1000,
          meta: { ipAddress: "127.0.0.1" },
        }),
  ),
  verifyOrigin: vi.fn(() => null),
  verifyCsrf: vi.fn(() => null),
}));

// ---------------------------------------------------------------------------
// Tests — GET /api/invitations
// ---------------------------------------------------------------------------

describe("GET /api/invitations", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  async function callGET(url: string) {
    const { GET } = await import("../route");
    return GET(new NextRequest(url));
  }

  it("returns 400 when customer_id is missing", async () => {
    const res = await callGET("http://localhost:3000/api/invitations");
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("customer_id");
  });

  it("returns 400 when customer_id is not a valid UUID", async () => {
    const res = await callGET(
      "http://localhost:3000/api/invitations?customer_id=not-a-uuid",
    );
    expect(res.status).toBe(400);
  });

  it("returns invitations on success", async () => {
    const mockInvitations: PendingInvitation[] = [
      {
        id: "inv-001",
        email: "user@example.com",
        role: "User",
        createdAt: "2025-01-01T00:00:00.000Z",
        expiresAt: "2025-01-08T00:00:00.000Z",
      },
    ];
    listPendingInvitationsMock.mockResolvedValue(mockInvitations);

    const res = await callGET(
      "http://localhost:3000/api/invitations?customer_id=00000000-0000-0000-0000-000000000001",
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.invitations).toHaveLength(1);
    expect(body.invitations[0].email).toBe("user@example.com");
  });

  it("forwards HttpError as JSON response", async () => {
    const { HttpError } = await import("@/lib/auth/errors");
    listPendingInvitationsMock.mockRejectedValue(
      new HttpError("Forbidden", 403),
    );

    const res = await callGET(
      "http://localhost:3000/api/invitations?customer_id=00000000-0000-0000-0000-000000000001",
    );
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe("Forbidden");
  });
});

// ---------------------------------------------------------------------------
// Tests — DELETE /api/invitations/:id
// ---------------------------------------------------------------------------

describe("DELETE /api/invitations/:id", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  async function callDELETE(url: string) {
    const { DELETE } = await import("../[id]/route");
    return DELETE(new NextRequest(url, { method: "DELETE" }));
  }

  it("returns 400 when id is not a valid UUID", async () => {
    const res = await callDELETE(
      "http://localhost:3000/api/invitations/not-a-uuid",
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("Invalid invitation ID");
  });

  it("returns 204 on successful revocation", async () => {
    revokeInvitationMock.mockResolvedValue(undefined);

    const res = await callDELETE(
      "http://localhost:3000/api/invitations/00000000-0000-0000-0000-000000000001",
    );
    expect(res.status).toBe(204);
  });

  it("forwards HttpError 404 as JSON response", async () => {
    const { HttpError } = await import("@/lib/auth/errors");
    revokeInvitationMock.mockRejectedValue(
      new HttpError("Invitation not found", 404),
    );

    const res = await callDELETE(
      "http://localhost:3000/api/invitations/00000000-0000-0000-0000-000000000001",
    );
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("Invitation not found");
  });

  it("forwards HttpError 403 as JSON response", async () => {
    const { HttpError } = await import("@/lib/auth/errors");
    revokeInvitationMock.mockRejectedValue(new HttpError("Forbidden", 403));

    const res = await callDELETE(
      "http://localhost:3000/api/invitations/00000000-0000-0000-0000-000000000001",
    );
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe("Forbidden");
  });
});
