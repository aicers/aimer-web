// RFC 0003 self-fetch (3a, #568) — route tests for the self-fetch admin
// surface: "Fetch Now" (`POST /fetch`), the write-only Auth-Key
// (`PUT /auth-key`), and mode gating (both 404 outside `self-fetch`; the
// shared GET status route is up in `self-fetch`).

import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const SELF_ACCOUNT_ID = "00000000-0000-0000-0000-000000000099";

const mockAssertAuthorized = vi.fn();
const mockFetchAndImport = vi.fn();
const mockFetchAndImportAll = vi.fn();
const mockSetFeedSourceSecret = vi.fn();
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

vi.mock("@/lib/auth/authorization", () => ({
  assertAuthorized: (...args: unknown[]) => mockAssertAuthorized(...args),
}));

vi.mock("@/lib/db/client", () => ({
  getAuthPool: vi.fn(() => ({
    connect: vi.fn(async () => ({ query: vi.fn(), release: vi.fn() })),
  })),
  getFeedPool: vi.fn(() => ({ query: vi.fn(async () => ({ rows: [] })) })),
}));

vi.mock("@/lib/analysis/enrichment/feed-fetch", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/lib/analysis/enrichment/feed-fetch")
    >();
  class MockSelfFetchFeedSource {
    fetchAndImport = (...args: unknown[]) => mockFetchAndImport(...args);
    fetchAndImportAll = (...args: unknown[]) => mockFetchAndImportAll(...args);
  }
  return {
    ...actual,
    SelfFetchFeedSource: MockSelfFetchFeedSource,
    setFeedSourceSecret: (...args: unknown[]) =>
      mockSetFeedSourceSecret(...args),
  };
});

const FETCH_URL = "http://localhost:3000/api/admin/ti-feed/fetch";
const AUTH_KEY_URL = "http://localhost:3000/api/admin/ti-feed/auth-key";

function makeFetch(body?: unknown): NextRequest {
  return new NextRequest(new URL(FETCH_URL), {
    method: "POST",
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function makeAuthKey(body: unknown): NextRequest {
  return new NextRequest(new URL(AUTH_KEY_URL), {
    method: "PUT",
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.TI_FEED_MODE = "self-fetch";
  mockVerifyOrigin = () => null;
  mockVerifyCsrf = () => null;
  mockAssertAuthorized.mockResolvedValue(
    new Set(["ti-feed:read", "ti-feed:write"]),
  );
  mockFetchAndImport.mockResolvedValue({ status: "imported", rowCount: 3 });
  mockFetchAndImportAll.mockResolvedValue([
    {
      sourcePolicyId: "abuse.ch/feodo",
      outcome: { status: "imported", rowCount: 1 },
    },
  ]);
});

// ---------------------------------------------------------------------------
// POST /api/admin/ti-feed/fetch
// ---------------------------------------------------------------------------

describe("POST /api/admin/ti-feed/fetch", () => {
  it("404s outside self-fetch mode", async () => {
    process.env.TI_FEED_MODE = "manual-upload";
    const { POST } = await import("../fetch/route");
    const res = await POST(makeFetch({ sourcePolicyId: "abuse.ch/feodo" }));
    expect(res.status).toBe(404);
    expect(mockFetchAndImport).not.toHaveBeenCalled();
  });

  it("enforces verifyOrigin", async () => {
    mockVerifyOrigin = () => Response.json({ error: "bad" }, { status: 403 });
    const { POST } = await import("../fetch/route");
    const res = await POST(makeFetch({ sourcePolicyId: "abuse.ch/feodo" }));
    expect(res.status).toBe(403);
    expect(mockFetchAndImport).not.toHaveBeenCalled();
  });

  it("enforces verifyCsrf", async () => {
    mockVerifyCsrf = () => Response.json({ error: "bad" }, { status: 403 });
    const { POST } = await import("../fetch/route");
    const res = await POST(makeFetch({ sourcePolicyId: "abuse.ch/feodo" }));
    expect(res.status).toBe(403);
  });

  it("403s without ti-feed:write", async () => {
    const { HttpError } = await import("@/lib/auth/errors");
    mockAssertAuthorized.mockRejectedValue(new HttpError("Forbidden", 403));
    const { POST } = await import("../fetch/route");
    const res = await POST(makeFetch({ sourcePolicyId: "abuse.ch/feodo" }));
    expect(res.status).toBe(403);
    expect(mockAssertAuthorized).toHaveBeenCalledWith(
      expect.anything(),
      "admin",
      SELF_ACCOUNT_ID,
      "ti-feed:write",
    );
  });

  it("fetches one source and returns its outcome", async () => {
    const { POST } = await import("../fetch/route");
    const res = await POST(makeFetch({ sourcePolicyId: "abuse.ch/feodo" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "imported", rowCount: 3 });
    expect(mockFetchAndImport).toHaveBeenCalledWith("abuse.ch/feodo");
  });

  it("maps a held lock to a benign error", async () => {
    mockFetchAndImport.mockResolvedValue({ status: "locked" });
    const { POST } = await import("../fetch/route");
    const res = await POST(makeFetch({ sourcePolicyId: "abuse.ch/feodo" }));
    const body = await res.json();
    expect(body.status).toBe("error");
    expect(body.error).toMatch(/already in progress/);
  });

  it("fetches all fetchable sources when no source is given", async () => {
    const { POST } = await import("../fetch/route");
    const res = await POST(makeFetch());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.results).toHaveLength(1);
    expect(mockFetchAndImportAll).toHaveBeenCalled();
  });

  it("400s for a non-string sourcePolicyId", async () => {
    const { POST } = await import("../fetch/route");
    const res = await POST(makeFetch({ sourcePolicyId: 42 }));
    expect(res.status).toBe(400);
    expect(mockFetchAndImport).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// PUT /api/admin/ti-feed/auth-key
// ---------------------------------------------------------------------------

describe("PUT /api/admin/ti-feed/auth-key", () => {
  it("404s outside self-fetch mode", async () => {
    process.env.TI_FEED_MODE = "manual-upload";
    const { PUT } = await import("../auth-key/route");
    const res = await PUT(makeAuthKey({ authKey: "k" }));
    expect(res.status).toBe(404);
    expect(mockSetFeedSourceSecret).not.toHaveBeenCalled();
  });

  it("enforces verifyOrigin + verifyCsrf", async () => {
    mockVerifyOrigin = () => Response.json({ error: "bad" }, { status: 403 });
    const { PUT } = await import("../auth-key/route");
    const res = await PUT(makeAuthKey({ authKey: "k" }));
    expect(res.status).toBe(403);
    expect(mockSetFeedSourceSecret).not.toHaveBeenCalled();
  });

  it("403s without ti-feed:write", async () => {
    const { HttpError } = await import("@/lib/auth/errors");
    mockAssertAuthorized.mockRejectedValue(new HttpError("Forbidden", 403));
    const { PUT } = await import("../auth-key/route");
    const res = await PUT(makeAuthKey({ authKey: "k" }));
    expect(res.status).toBe(403);
  });

  it("stores the Auth-Key and never echoes it back", async () => {
    const { PUT } = await import("../auth-key/route");
    const res = await PUT(
      makeAuthKey({ keyName: "urlhaus", authKey: "secret" }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true });
    expect(JSON.stringify(body)).not.toContain("secret");
    expect(mockSetFeedSourceSecret).toHaveBeenCalledWith(
      expect.anything(),
      "urlhaus",
      "secret",
    );
  });

  it("400s for a missing authKey", async () => {
    const { PUT } = await import("../auth-key/route");
    const res = await PUT(makeAuthKey({ keyName: "urlhaus" }));
    expect(res.status).toBe(400);
    expect(mockSetFeedSourceSecret).not.toHaveBeenCalled();
  });

  it("400s for an unknown key name", async () => {
    const { PUT } = await import("../auth-key/route");
    const res = await PUT(makeAuthKey({ keyName: "bogus", authKey: "k" }));
    expect(res.status).toBe(400);
    expect(mockSetFeedSourceSecret).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Shared GET status route — up in self-fetch mode
// ---------------------------------------------------------------------------

describe("GET /api/admin/ti-feed (shared surface, self-fetch)", () => {
  it("is reachable in self-fetch mode and reports the mode", async () => {
    const { GET } = await import("../route");
    const res = await GET(
      new NextRequest(new URL("http://localhost/api/admin/ti-feed")),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.mode).toBe("self-fetch");
    expect(Array.isArray(body.sources)).toBe(true);
  });

  it("marks a never-fetched fetchable source as due now, not a bare null", async () => {
    // With no `feed_fetch_state` rows, every fetchable source has never been
    // fetched. The status GET must surface that as `dueNow: true` (the worker
    // fetches it on the next tick) rather than a bare `nextFetchDueAt: null`,
    // which the UI would render as "—" — indistinguishable from a merged,
    // non-fetchable source.
    const { GET } = await import("../route");
    const res = await GET(
      new NextRequest(new URL("http://localhost/api/admin/ti-feed")),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    const feodo = body.sources.find(
      (s: { sourcePolicyId: string }) => s.sourcePolicyId === "abuse.ch/feodo",
    );
    expect(feodo).toMatchObject({
      fetchable: true,
      lastFetchedAt: null,
      nextFetchDueAt: null,
      dueNow: true,
    });
    // A non-fetchable (merged) source is never "due now".
    const edrop = body.sources.find(
      (s: { sourcePolicyId: string }) => s.sourcePolicyId === "spamhaus/edrop",
    );
    expect(edrop).toMatchObject({ fetchable: false, dueNow: false });
  });

  it("404s in fixture mode (neither manual-upload nor self-fetch)", async () => {
    process.env.TI_FEED_MODE = "fixture";
    const { GET } = await import("../route");
    const res = await GET(
      new NextRequest(new URL("http://localhost/api/admin/ti-feed")),
    );
    expect(res.status).toBe(404);
  });
});
