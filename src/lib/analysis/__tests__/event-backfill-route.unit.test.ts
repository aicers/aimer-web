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
  getAuthPool: () => ({ connect: async () => ({ release: () => {} }) }),
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

vi.mock("../default-model", () => ({
  resolveDefaultModel: async () => ({ modelName: "openai", model: "gpt-5.5" }),
}));

const previewBackfill = vi.fn(async () => ({
  totalUniverse: 10,
  reanalyze: 6,
  alreadyCurrent: 2,
  sourceUnavailable: 1,
  capExcluded: 1,
}));
vi.mock("../event-leaf-backfill", async () => {
  const actual = await vi.importActual<typeof import("../event-leaf-backfill")>(
    "../event-leaf-backfill",
  );
  return { ...actual, previewBackfill: () => previewBackfill() };
});

const createRun = vi.fn(async (..._a: unknown[]) => ({
  run: { id: "run-1", status: "pending" },
  created: true,
}));
const requestCancel = vi.fn(async (..._a: unknown[]) => null);
vi.mock("../event-leaf-backfill-store", () => ({
  createRun: (...a: unknown[]) => createRun(...a),
  requestCancel: (...a: unknown[]) => requestCancel(...a),
  getRun: vi.fn(),
  listRuns: vi.fn(async () => []),
}));

vi.mock("../event-leaf-drain", () => ({
  computeEventLeafDrain: vi.fn(async () => ({ drained: true })),
}));

import {
  handleCancelRun,
  handleCreateRun,
  handlePreview,
} from "../event-backfill-route";

const CUSTOMER = "11111111-1111-1111-1111-111111111111";
const RUN = "22222222-2222-2222-2222-222222222222";

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
  meta: { ipAddress: "127.0.0.1" },
  // biome-ignore lint/suspicious/noExplicitAny: minimal auth double
} as any;

describe("event-backfill route handlers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    assertAuthorized.mockResolvedValue(undefined);
  });

  it("preview returns the categorized counts and resolved scope", async () => {
    const res = await handlePreview(
      req(`/api/admin/customers/${CUSTOMER}/event-backfill/preview`),
      auth,
      "admin",
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.counts.reanalyze).toBe(6);
    expect(body.target).toEqual({
      lang: "ENGLISH",
      modelName: "openai",
      model: "gpt-5.5",
    });
    expect(body.windowDays).toBe(7);
  });

  it("create REQUIRES explicit confirmation", async () => {
    const res = await handleCreateRun(
      req(`/api/admin/customers/${CUSTOMER}/event-backfill`, {
        body: { windowDays: 7 },
      }),
      auth,
      "admin",
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("confirmation_required");
    expect(createRun).not.toHaveBeenCalled();
  });

  it("create launches the run when confirmed", async () => {
    const res = await handleCreateRun(
      req(`/api/admin/customers/${CUSTOMER}/event-backfill`, {
        body: { windowDays: 7, confirm: true },
      }),
      auth,
      "admin",
    );
    expect(res.status).toBe(201);
    expect(createRun).toHaveBeenCalledOnce();
    const body = await res.json();
    expect(body.run.id).toBe("run-1");
  });

  it("preview honours an explicit non-default target language", async () => {
    const res = await handlePreview(
      req(`/api/admin/customers/${CUSTOMER}/event-backfill/preview`, {
        search: "lang=KOREAN",
      }),
      auth,
      "admin",
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.target.lang).toBe("KOREAN");
  });

  it("create passes the explicit target language through to the run", async () => {
    const res = await handleCreateRun(
      req(`/api/admin/customers/${CUSTOMER}/event-backfill`, {
        body: { windowDays: 7, lang: "KOREAN", confirm: true },
      }),
      auth,
      "admin",
    );
    expect(res.status).toBe(201);
    expect(createRun).toHaveBeenCalledOnce();
    const params = createRun.mock.calls[0][2] as { target: { lang: string } };
    expect(params.target.lang).toBe("KOREAN");
  });

  it("cancel returns 409 when the run is not cancellable", async () => {
    const res = await handleCancelRun(
      req(`/api/admin/customers/${CUSTOMER}/event-backfill/runs/${RUN}/cancel`),
      auth,
      "admin",
    );
    expect(res.status).toBe(409);
  });

  it("propagates an authorization failure as its HTTP status", async () => {
    const { HttpError } = await import("@/lib/auth/errors");
    assertAuthorized.mockRejectedValueOnce(new HttpError("Forbidden", 403));
    const res = await handlePreview(
      req(`/api/admin/customers/${CUSTOMER}/event-backfill/preview`),
      auth,
      "admin",
    );
    expect(res.status).toBe(403);
  });
});
