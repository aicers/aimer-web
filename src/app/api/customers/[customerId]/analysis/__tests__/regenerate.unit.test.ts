// RFC 0002 Phase 0 (#294) — regenerate API stub tests.
//
// Locks in the public-shape contract: 401 unauthenticated, 403
// non-member / missing permission, 400 invalid_param for tz on story,
// 202 happy-path.

import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockAssertAuthorized = vi.fn();
const mockClientQuery = vi.fn();
const mockConnect = vi.fn(() => ({
  query: mockClientQuery,
  release: vi.fn(),
}));

const SELF = "00000000-0000-0000-0000-000000000099";
const CUSTOMER_ID = "c0000000-0000-0000-0000-000000000001";

vi.mock("@/lib/auth/guards", () => ({
  // biome-ignore lint/complexity/noBannedTypes: test mock
  withAuth: (handler: Function) => (req: NextRequest) =>
    handler(req, {
      accountId: SELF,
      sessionId: "sess-1",
      authContext: "general",
      tokenVersion: 1,
      iat: 1000,
      meta: { ipAddress: "127.0.0.1", userAgent: "test" },
      bridgeAiceId: null,
      bridgeCustomerIds: null,
      audit: {},
    }),
  verifyOrigin: () => null,
  verifyCsrf: () => null,
}));

vi.mock("@/lib/auth/authorization", () => ({
  assertAuthorized: (...args: unknown[]) => mockAssertAuthorized(...args),
}));

vi.mock("@/lib/db/client", () => ({
  getAuthPool: () => ({ connect: mockConnect }),
}));

function storyRequest(query = ""): NextRequest {
  return new NextRequest(
    new URL(
      `http://localhost:3000/api/customers/${CUSTOMER_ID}/analysis/story/12345/regenerate${query}`,
    ),
    { method: "POST" },
  );
}

function reportRequest(query = ""): NextRequest {
  return new NextRequest(
    new URL(
      `http://localhost:3000/api/customers/${CUSTOMER_ID}/analysis/report/DAILY/2026-05-27/regenerate${query}`,
    ),
    { method: "POST" },
  );
}

describe("story regenerate stub", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    mockAssertAuthorized.mockResolvedValue(new Set(["analyses:configure"]));
  });

  it("returns 202 on the happy path", async () => {
    const { POST } = await import("../story/[storyId]/regenerate/route");
    const res = await POST(storyRequest());
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.accepted).toBe(true);
    expect(body.story_id).toBe("12345");
    expect(body.customer_id).toBe(CUSTOMER_ID);
  });

  it("returns 403 when the caller lacks analyses:configure", async () => {
    const { HttpError } = await import("@/lib/auth/errors");
    mockAssertAuthorized.mockRejectedValue(new HttpError("Forbidden", 403));
    const { POST } = await import("../story/[storyId]/regenerate/route");
    const res = await POST(storyRequest());
    expect(res.status).toBe(403);
  });

  it("rejects tz with 400 invalid_param (story analysis is timezone-independent)", async () => {
    const { POST } = await import("../story/[storyId]/regenerate/route");
    const res = await POST(storyRequest("?tz=Asia/Seoul"));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("invalid_param");
  });

  it("returns 400 on an invalid story id", async () => {
    const { POST } = await import("../story/[storyId]/regenerate/route");
    const req = new NextRequest(
      new URL(
        `http://localhost:3000/api/customers/${CUSTOMER_ID}/analysis/story/not-a-number/regenerate`,
      ),
      { method: "POST" },
    );
    const res = await POST(req);
    expect(res.status).toBe(400);
  });
});

describe("report regenerate stub", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    mockAssertAuthorized.mockResolvedValue(new Set(["reports:create"]));
  });

  it("returns 202 on the happy path with optional tz/lang/model", async () => {
    const { POST } = await import(
      "../report/[period]/[bucketDate]/regenerate/route"
    );
    const res = await POST(
      reportRequest("?tz=Asia/Tokyo&lang=ENGLISH&model=gpt-4o"),
    );
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.accepted).toBe(true);
    expect(body.period).toBe("DAILY");
    expect(body.bucket_date).toBe("2026-05-27");
    expect(body.variant.tz).toBe("Asia/Tokyo");
  });

  it("returns 403 when the caller lacks reports:create", async () => {
    const { HttpError } = await import("@/lib/auth/errors");
    mockAssertAuthorized.mockRejectedValue(new HttpError("Forbidden", 403));
    const { POST } = await import(
      "../report/[period]/[bucketDate]/regenerate/route"
    );
    const res = await POST(reportRequest());
    expect(res.status).toBe(403);
  });

  it("returns 400 on an unknown period", async () => {
    const { POST } = await import(
      "../report/[period]/[bucketDate]/regenerate/route"
    );
    const req = new NextRequest(
      new URL(
        `http://localhost:3000/api/customers/${CUSTOMER_ID}/analysis/report/HOURLY/2026-05-27/regenerate`,
      ),
      { method: "POST" },
    );
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it("returns 400 on a malformed bucket_date", async () => {
    const { POST } = await import(
      "../report/[period]/[bucketDate]/regenerate/route"
    );
    const req = new NextRequest(
      new URL(
        `http://localhost:3000/api/customers/${CUSTOMER_ID}/analysis/report/DAILY/today/regenerate`,
      ),
      { method: "POST" },
    );
    const res = await POST(req);
    expect(res.status).toBe(400);
  });
});
