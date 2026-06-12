import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const SELF_ACCOUNT_ID = "00000000-0000-0000-0000-000000000099";

const mockAssertAuthorized = vi.fn();
const mockFeedQuery = vi.fn();
const mockImportRawFeedPayload = vi.fn();
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
  getFeedPool: vi.fn(() => ({ query: mockFeedQuery })),
}));

vi.mock("@/lib/analysis/enrichment/feed-import", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/lib/analysis/enrichment/feed-import")
    >();
  return {
    ...actual,
    importRawFeedPayload: (...args: unknown[]) =>
      mockImportRawFeedPayload(...args),
  };
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const GET_URL = "http://localhost:3000/api/admin/ti-feed";
const POST_URL = "http://localhost:3000/api/admin/ti-feed/upload";

function makeGet(): NextRequest {
  return new NextRequest(new URL(GET_URL), { method: "GET" });
}

function makeUpload(parts: {
  sourcePolicyId?: string;
  file?: { name: string; content: string };
}): NextRequest {
  const form = new FormData();
  if (parts.sourcePolicyId !== undefined) {
    form.append("sourcePolicyId", parts.sourcePolicyId);
  }
  if (parts.file) {
    form.append(
      "file",
      new File([parts.file.content], parts.file.name, { type: "text/plain" }),
    );
  }
  return new NextRequest(new URL(POST_URL), { method: "POST", body: form });
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.TI_FEED_MODE = "manual-upload";
  mockVerifyOrigin = () => null;
  mockVerifyCsrf = () => null;
  mockAssertAuthorized.mockResolvedValue(
    new Set(["ti-feed:read", "ti-feed:write"]),
  );
  mockFeedQuery.mockResolvedValue({ rows: [] });
  mockImportRawFeedPayload.mockResolvedValue({ rowCount: 1, feedHash: "hash" });
});

// ---------------------------------------------------------------------------
// GET /api/admin/ti-feed
// ---------------------------------------------------------------------------

describe("GET /api/admin/ti-feed", () => {
  it("returns 404 when TI_FEED_MODE is not manual-upload", async () => {
    process.env.TI_FEED_MODE = "fixture";
    const { GET } = await import("../route");
    const res = await GET(makeGet());
    expect(res.status).toBe(404);
  });

  it("calls assertAuthorized with ti-feed:read", async () => {
    const { GET } = await import("../route");
    await GET(makeGet());
    expect(mockAssertAuthorized).toHaveBeenCalledWith(
      expect.anything(),
      "admin",
      SELF_ACCOUNT_ID,
      "ti-feed:read",
    );
  });

  it("returns 403 when not authorized", async () => {
    const { HttpError } = await import("@/lib/auth/errors");
    mockAssertAuthorized.mockRejectedValue(new HttpError("Forbidden", 403));
    const { GET } = await import("../route");
    const res = await GET(makeGet());
    expect(res.status).toBe(403);
  });

  it("reports every catalog source, reflecting imported rows", async () => {
    mockFeedQuery.mockResolvedValue({
      rows: [
        {
          source_policy_id: "abuse.ch/feodo",
          row_count: "2",
          source_updated_at: new Date("2026-06-12T00:00:00.000Z"),
          feed_hash: "h1",
        },
      ],
    });
    const { GET } = await import("../route");
    const res = await GET(makeGet());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.sources).toHaveLength(5);
    const feodo = body.sources.find(
      (s: { sourcePolicyId: string }) => s.sourcePolicyId === "abuse.ch/feodo",
    );
    expect(feodo).toMatchObject({
      present: true,
      rowCount: 2,
      feedHash: "h1",
    });
    const urlhaus = body.sources.find(
      (s: { sourcePolicyId: string }) =>
        s.sourcePolicyId === "abuse.ch/urlhaus",
    );
    expect(urlhaus).toMatchObject({
      present: false,
      rowCount: 0,
      feedHash: null,
      sourceUpdatedAt: null,
    });
  });
});

// ---------------------------------------------------------------------------
// POST /api/admin/ti-feed/upload
// ---------------------------------------------------------------------------

describe("POST /api/admin/ti-feed/upload", () => {
  it("returns 404 when TI_FEED_MODE is not manual-upload", async () => {
    process.env.TI_FEED_MODE = "fixture";
    const { POST } = await import("../upload/route");
    const res = await POST(
      makeUpload({
        sourcePolicyId: "abuse.ch/feodo",
        file: { name: "f.txt", content: "45.66.230.5\n" },
      }),
    );
    expect(res.status).toBe(404);
  });

  it("enforces verifyOrigin", async () => {
    mockVerifyOrigin = () =>
      Response.json({ error: "bad origin" }, { status: 403 });
    const { POST } = await import("../upload/route");
    const res = await POST(
      makeUpload({
        sourcePolicyId: "abuse.ch/feodo",
        file: { name: "f.txt", content: "45.66.230.5\n" },
      }),
    );
    expect(res.status).toBe(403);
    expect(mockImportRawFeedPayload).not.toHaveBeenCalled();
  });

  it("enforces verifyCsrf", async () => {
    mockVerifyCsrf = () =>
      Response.json({ error: "bad csrf" }, { status: 403 });
    const { POST } = await import("../upload/route");
    const res = await POST(
      makeUpload({
        sourcePolicyId: "abuse.ch/feodo",
        file: { name: "f.txt", content: "45.66.230.5\n" },
      }),
    );
    expect(res.status).toBe(403);
  });

  it("returns 403 when not authorized (ti-feed:write)", async () => {
    const { HttpError } = await import("@/lib/auth/errors");
    mockAssertAuthorized.mockRejectedValue(new HttpError("Forbidden", 403));
    const { POST } = await import("../upload/route");
    const res = await POST(
      makeUpload({
        sourcePolicyId: "abuse.ch/feodo",
        file: { name: "f.txt", content: "45.66.230.5\n" },
      }),
    );
    expect(res.status).toBe(403);
    expect(mockAssertAuthorized).toHaveBeenCalledWith(
      expect.anything(),
      "admin",
      SELF_ACCOUNT_ID,
      "ti-feed:write",
    );
  });

  it("returns 400 for a missing file", async () => {
    const { POST } = await import("../upload/route");
    const res = await POST(makeUpload({ sourcePolicyId: "abuse.ch/feodo" }));
    expect(res.status).toBe(400);
  });

  it("returns 400 for an unknown sourcePolicyId", async () => {
    const { POST } = await import("../upload/route");
    const res = await POST(
      makeUpload({
        sourcePolicyId: "bogus/source",
        file: { name: "f.txt", content: "45.66.230.5\n" },
      }),
    );
    expect(res.status).toBe(400);
    expect(mockImportRawFeedPayload).not.toHaveBeenCalled();
  });

  it("returns 400 for unparseable non-empty content", async () => {
    const { POST } = await import("../upload/route");
    const res = await POST(
      makeUpload({
        sourcePolicyId: "abuse.ch/urlhaus",
        file: { name: "f.txt", content: "not a csv at all\nnope\n" },
      }),
    );
    expect(res.status).toBe(400);
    expect(mockImportRawFeedPayload).not.toHaveBeenCalled();
  });

  it("accepts empty / comment-only content as a clear (rowCount 0)", async () => {
    mockImportRawFeedPayload.mockResolvedValue({ rowCount: 0, feedHash: "h0" });
    const { POST } = await import("../upload/route");
    const res = await POST(
      makeUpload({
        sourcePolicyId: "abuse.ch/feodo",
        file: { name: "f.txt", content: "# only comments\n\n" },
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ rowCount: 0, feedHash: "h0" });
    expect(mockImportRawFeedPayload).toHaveBeenCalled();
  });

  it("imports a valid file and returns rowCount + feedHash", async () => {
    mockImportRawFeedPayload.mockResolvedValue({
      rowCount: 3,
      feedHash: "abc",
    });
    const { POST } = await import("../upload/route");
    const res = await POST(
      makeUpload({
        sourcePolicyId: "abuse.ch/feodo",
        file: { name: "feodo.txt", content: "45.66.230.5\n198.51.100.7\n" },
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ rowCount: 3, feedHash: "abc" });

    // The payload passed downstream carries catalog fields + provenance.
    const [, payload] = mockImportRawFeedPayload.mock.calls[0];
    expect(payload).toMatchObject({
      sourcePolicyId: "abuse.ch/feodo",
      parse: "ip-blocklist",
      provenance: { mode: "manual-upload", origin: "manual-upload:feodo.txt" },
    });
  });
});
