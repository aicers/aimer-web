import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

// Guards pass by default; CSRF/origin return null (ok).
vi.mock("@/lib/auth/guards", () => ({
  verifyOrigin: () => null,
  verifyCsrf: () => null,
}));

const assertAuthorized = vi.fn(async (..._args: unknown[]) => {});
vi.mock("@/lib/auth/authorization", () => ({
  assertAuthorized: (...args: unknown[]) => assertAuthorized(...args),
}));

vi.mock("@/lib/db/client", () => ({
  getAuthPool: () => ({
    connect: async () => ({
      query: async () => ({ rows: [] }),
      release: () => {},
    }),
  }),
  withTransaction: async (
    _pool: unknown,
    cb: (client: unknown) => Promise<unknown>,
  ) => cb({}),
}));

vi.mock("@/lib/db/customer-runtime-pool", () => ({
  getCustomerRuntimePool: () => ({ query: async () => ({ rows: [] }) }),
}));

vi.mock("@/lib/instrumentation/time", () => ({
  getCurrentTimestamp: () => new Date("2026-06-08T00:00:00.000Z"),
}));

vi.mock("@/lib/audit", () => ({ auditLog: vi.fn() }));

vi.mock("../default-model", () => ({
  resolveDefaultModel: async () => ({ modelName: "openai", model: "gpt-5.5" }),
}));

const COUNTS = {
  totalVariants: 8,
  refreshed: 3,
  capped: 1,
  gated: 2,
  alreadyQueued: 1,
  sourceUnavailable: 1,
  limited: 0,
};

const evaluateCandidates = vi.fn(async (..._a: unknown[]) => []);
const planRefresh = vi.fn((..._a: unknown[]) => ({
  counts: COUNTS,
  variants: [],
}));
const executeReportRefresh = vi.fn(async (..._a: unknown[]) => ({
  counts: COUNTS,
  variants: [],
}));
vi.mock("../report-refresh", async () => {
  const actual =
    await vi.importActual<typeof import("../report-refresh")>(
      "../report-refresh",
    );
  return {
    ...actual,
    evaluateCandidates: (...a: unknown[]) => evaluateCandidates(...a),
    planRefresh: (...a: unknown[]) => planRefresh(...a),
    executeReportRefresh: (...a: unknown[]) => executeReportRefresh(...a),
  };
});

const recordRun = vi.fn(async (..._a: unknown[]) => ({
  id: "run-1",
  status: "completed",
}));
vi.mock("../report-refresh-store", () => ({
  recordRun: (...a: unknown[]) => recordRun(...a),
  getRun: vi.fn(),
  getRunItems: vi.fn(async () => []),
  listRuns: vi.fn(async () => []),
}));

import { handleCreateRun, handlePreview } from "../report-refresh-route";

const CUSTOMER = "11111111-1111-1111-1111-111111111111";

// biome-ignore lint/suspicious/noExplicitAny: minimal request double
function req(path: string, opts?: { search?: string; body?: any }): any {
  return {
    nextUrl: {
      pathname: path,
      searchParams: new URLSearchParams(opts?.search ?? ""),
    },
    json: async () => opts?.body ?? {},
  };
}

const auth = {
  accountId: "acc-1",
  sessionId: "sid-1",
  iat: 0,
  // biome-ignore lint/suspicious/noExplicitAny: minimal auth double
} as any;

describe("report-refresh route handlers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    assertAuthorized.mockResolvedValue(undefined);
  });

  it("preview returns the per-outcome counts and resolved scope", async () => {
    const res = await handlePreview(
      req(`/api/admin/customers/${CUSTOMER}/report-refresh/preview`),
      auth,
      "admin",
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.counts.refreshed).toBe(3);
    expect(body.counts.gated).toBe(2);
    expect(body.target).toEqual({
      lang: "ENGLISH",
      modelName: "openai",
      model: "gpt-5.5",
    });
    expect(body.windowDays).toBe(7);
    expect(body.periods).toEqual(["LIVE", "DAILY", "WEEKLY", "MONTHLY"]);
    expect(executeReportRefresh).not.toHaveBeenCalled();
  });

  it("create REQUIRES explicit confirmation", async () => {
    const res = await handleCreateRun(
      req(`/api/admin/customers/${CUSTOMER}/report-refresh`, {
        body: { windowDays: 7 },
      }),
      auth,
      "admin",
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("confirmation_required");
    expect(executeReportRefresh).not.toHaveBeenCalled();
    expect(recordRun).not.toHaveBeenCalled();
  });

  it("create runs the refresh when confirmed and persists the run", async () => {
    const res = await handleCreateRun(
      req(`/api/admin/customers/${CUSTOMER}/report-refresh`, {
        body: { windowDays: 7, confirm: true },
      }),
      auth,
      "admin",
    );
    expect(res.status).toBe(201);
    expect(executeReportRefresh).toHaveBeenCalledOnce();
    expect(recordRun).toHaveBeenCalledOnce();
    const body = await res.json();
    expect(body.run.id).toBe("run-1");
  });

  it("rejects an unknown period token rather than silently narrowing scope", async () => {
    const res = await handlePreview(
      req(`/api/admin/customers/${CUSTOMER}/report-refresh/preview`, {
        search: "periods=DAILY,BOGUS",
      }),
      auth,
      "admin",
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("invalid_period");
  });

  it("propagates an authorization failure as its HTTP status", async () => {
    const { HttpError } = await import("@/lib/auth/errors");
    assertAuthorized.mockRejectedValueOnce(new HttpError("Forbidden", 403));
    const res = await handlePreview(
      req(`/api/admin/customers/${CUSTOMER}/report-refresh/preview`),
      auth,
      "admin",
    );
    expect(res.status).toBe(403);
  });
});
