import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { InvitationType } from "@/lib/auth/analyst-invitations";

// ---------------------------------------------------------------------------
// Invite entry endpoint dual lookup (#268). The route delegates the dual
// pending+unexpired lookup to resolveInvitationType; here we pin the
// route-level contract: set the shared cookie + sign-in redirect (with
// Referrer-Policy) for BOTH invitation types, deny only on not_found.
// ---------------------------------------------------------------------------

const resolveInvitationTypeMock = vi.fn<() => Promise<InvitationType>>();
const setInvitationTokenCookie = vi.fn();
const clearConnectionIdCookie = vi.fn();

vi.mock("@/lib/auth/analyst-invitations", () => ({
  resolveInvitationType: () => resolveInvitationTypeMock(),
}));

vi.mock("@/lib/auth/cookies", () => ({
  setInvitationTokenCookie,
  clearConnectionIdCookie,
}));

vi.mock("@/lib/db/client", () => ({
  getAuthPool: vi.fn(() => ({})),
}));

async function callGET(type: InvitationType) {
  resolveInvitationTypeMock.mockResolvedValue(type);
  const { GET } = await import("../invite/[token]/route");
  const req = new NextRequest("http://localhost:3000/api/auth/invite/the-tok");
  return GET(req, { params: Promise.resolve({ token: "the-tok" }) });
}

describe("invite entry endpoint — dual lookup (#268)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("analyst token: sets the shared cookie and redirects to sign-in with Referrer-Policy", async () => {
    const res = await callGET("analyst");
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain(
      "/api/auth/sign-in?flow=invite",
    );
    expect(res.headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(setInvitationTokenCookie).toHaveBeenCalledWith("the-tok");
  });

  it("member token: same cookie + redirect (single success path)", async () => {
    const res = await callGET("member");
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain(
      "/api/auth/sign-in?flow=invite",
    );
    expect(res.headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(setInvitationTokenCookie).toHaveBeenCalledWith("the-tok");
  });

  it("not_found: denies and does not set the cookie", async () => {
    const res = await callGET("not_found");
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain(
      "/deny?reason=invitation_expired",
    );
    expect(setInvitationTokenCookie).not.toHaveBeenCalled();
  });
});
