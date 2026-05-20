import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockAssertAuthorized = vi.fn();
const mockClientQuery = vi.fn();
const mockClientRelease = vi.fn();
const mockConnect = vi.fn(() => ({
  query: mockClientQuery,
  release: mockClientRelease,
}));

const SELF = "00000000-0000-0000-0000-000000000099";
const CUSTOMER_ID = "c0000000-0000-0000-0000-000000000001";

const mockAuditMeta: {
  targetId?: string;
  details?: unknown;
  customerId?: string;
} = {};

vi.mock("@/lib/auth/guards", () => ({
  // biome-ignore lint/complexity/noBannedTypes: test mock
  withAuth: (handler: Function) => (req: NextRequest) => {
    mockAuditMeta.targetId = undefined;
    mockAuditMeta.details = undefined;
    mockAuditMeta.customerId = undefined;
    return handler(req, {
      accountId: SELF,
      sessionId: "sess-1",
      authContext: "general",
      tokenVersion: 1,
      iat: 1000,
      meta: { ipAddress: "127.0.0.1", userAgent: "test" },
      bridgeAiceId: null,
      bridgeCustomerIds: null,
      audit: mockAuditMeta,
    });
  },
  verifyOrigin: () => null,
  verifyCsrf: () => null,
}));

vi.mock("@/lib/auth/authorization", () => ({
  assertAuthorized: (...args: unknown[]) => mockAssertAuthorized(...args),
}));

vi.mock("@/lib/db/client", () => ({
  getAuthPool: () => ({ connect: mockConnect }),
}));

function makeGetRequest(): NextRequest {
  return new NextRequest(
    new URL(
      `http://localhost:3000/api/admin/customers/${CUSTOMER_ID}/redaction-ranges`,
    ),
    { method: "GET" },
  );
}

function makePostRequest(body: unknown): NextRequest {
  return new NextRequest(
    new URL(
      `http://localhost:3000/api/admin/customers/${CUSTOMER_ID}/redaction-ranges`,
    ),
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );
}

// POST wraps validate + insert in a transaction with a per-customer
// advisory lock, so the query stream is roughly
// `BEGIN / pg_advisory_xact_lock / SELECT existing / INSERT / COMMIT`.
// Tests use this helper to install a `mockImplementation` that
// auto-responds to the transaction bookkeeping queries and serves
// data-query responses from a per-test queue.
type QueryResponse = { rows: unknown[] } | { throw: unknown };
function isTxBookkeeping(text: string): boolean {
  const upper = text.toUpperCase();
  return (
    upper.startsWith("BEGIN") ||
    upper.startsWith("COMMIT") ||
    upper.startsWith("ROLLBACK") ||
    upper.includes("PG_ADVISORY_XACT_LOCK")
  );
}

describe("redaction-ranges route", () => {
  let queue: QueryResponse[] = [];

  beforeEach(() => {
    vi.clearAllMocks();
    mockAssertAuthorized.mockResolvedValue(
      new Set([
        "customer-redaction-ranges:read",
        "customer-redaction-ranges:write",
      ]),
    );
    queue = [];
    mockClientQuery.mockImplementation((text: string) => {
      if (isTxBookkeeping(text)) return Promise.resolve({ rows: [] });
      const next = queue.shift();
      if (!next) return Promise.resolve({ rows: [] });
      if ("throw" in next) return Promise.reject(next.throw);
      return Promise.resolve(next);
    });
  });

  function queueRows(rows: unknown[]): void {
    queue.push({ rows });
  }
  function queueThrow(err: unknown): void {
    queue.push({ throw: err });
  }

  it("GET lists ranges", async () => {
    queueRows([
      {
        id: "r1",
        cidr: "203.0.113.0/24",
        ip_version: 4,
        created_at: "2026-01-01",
      },
    ]);
    const { GET } = await import("../route");
    const res = await GET(makeGetRequest());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ranges).toHaveLength(1);
    expect(body.ranges[0].cidr).toBe("203.0.113.0/24");
  });

  it("POST rejects an invalid CIDR with 422", async () => {
    queueRows([]); // SELECT existing
    const { POST } = await import("../route");
    const res = await POST(makePostRequest({ cidr: "not-a-cidr" }));
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toBe("cidr_invalid");
  });

  it("POST rejects a private RFC 1918 range with cidr_private", async () => {
    queueRows([]);
    const { POST } = await import("../route");
    const res = await POST(makePostRequest({ cidr: "10.0.0.0/8" }));
    expect(res.status).toBe(422);
    expect((await res.json()).error).toBe("cidr_private");
  });

  it("POST rejects an IPv6 ULA range with cidr_private", async () => {
    queueRows([]);
    const { POST } = await import("../route");
    const res = await POST(makePostRequest({ cidr: "fc00::/7" }));
    expect((await res.json()).error).toBe("cidr_private");
  });

  it("POST normalises host bits and stores the network address", async () => {
    queueRows([]); // SELECT existing
    queueRows([{ id: "new", created_at: "2026-01-01" }]); // INSERT RETURNING
    const { POST } = await import("../route");
    const res = await POST(makePostRequest({ cidr: "203.0.113.5/24" }));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.cidr).toBe("203.0.113.0/24");
    // INSERT must have received the normalised form. Find the INSERT
    // call by inspecting query text rather than by position, since
    // BEGIN / advisory-lock calls shift indices.
    const insertCall = mockClientQuery.mock.calls.find(
      (c) => typeof c[0] === "string" && c[0].includes("INSERT INTO"),
    );
    expect(insertCall?.[1]?.[1]).toBe("203.0.113.0/24");
  });

  it("POST rejects a duplicate (after normalisation)", async () => {
    queueRows([{ cidr: "203.0.113.0/24", ip_version: 4 }]);
    const { POST } = await import("../route");
    const res = await POST(makePostRequest({ cidr: "203.0.113.0/24" }));
    expect((await res.json()).error).toBe("cidr_duplicate");
  });

  it("POST rejects an overlapping subset", async () => {
    queueRows([{ cidr: "203.0.113.0/24", ip_version: 4 }]);
    const { POST } = await import("../route");
    const res = await POST(makePostRequest({ cidr: "203.0.113.128/25" }));
    expect((await res.json()).error).toBe("cidr_overlaps");
  });

  it("POST maps a 23505 unique violation to cidr_duplicate", async () => {
    // SELECT returns no existing rows (so in-memory validation passes),
    // but the INSERT loses a race with a concurrent insert and the DB
    // raises the table-level UNIQUE (customer_id, cidr) constraint.
    queueRows([]);
    queueThrow(Object.assign(new Error("duplicate"), { code: "23505" }));
    const { POST } = await import("../route");
    const res = await POST(makePostRequest({ cidr: "203.0.113.0/24" }));
    expect(res.status).toBe(422);
    expect((await res.json()).error).toBe("cidr_duplicate");
  });

  it("POST opens a transaction and acquires the per-customer advisory lock", async () => {
    queueRows([]); // SELECT existing
    queueRows([{ id: "new", created_at: "2026-01-01" }]); // INSERT
    const { POST } = await import("../route");
    const res = await POST(makePostRequest({ cidr: "203.0.113.0/24" }));
    expect(res.status).toBe(201);
    const queryTexts = mockClientQuery.mock.calls.map((c) => String(c[0]));
    expect(queryTexts.some((t) => t.toUpperCase().startsWith("BEGIN"))).toBe(
      true,
    );
    expect(
      queryTexts.some((t) => t.toUpperCase().includes("PG_ADVISORY_XACT_LOCK")),
    ).toBe(true);
    expect(queryTexts.some((t) => t.toUpperCase().startsWith("COMMIT"))).toBe(
      true,
    );
  });
});
