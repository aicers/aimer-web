// Unit test for the reverse-citation lookup (T2, #396). Covers the
// containment-probe shape per leaf kind, the reports:read permission gate
// (empty trail on any auth failure), per-bucket dedupe keeping the
// newest-first representative, and the lang→app-locale mapping the link
// uses. The DB pool is stubbed; the GIN-backed query itself is exercised
// by the db tests.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mockGetAuthCookie = vi.fn();
const mockVerifyJwtFull = vi.fn();
const mockAuthorize = vi.fn();
const mockGetSessionPolicy = vi.fn();
const mockValidateSession = vi.fn();

vi.mock("@/lib/auth/cookies", () => ({
  getAuthCookie: (...args: unknown[]) => mockGetAuthCookie(...args),
}));
vi.mock("@/lib/auth/jwt", () => ({
  verifyJwtFull: (...args: unknown[]) => mockVerifyJwtFull(...args),
}));
vi.mock("@/lib/auth/authorization", () => ({
  authorize: (...args: unknown[]) => mockAuthorize(...args),
}));
vi.mock("@/lib/auth/session-policy", () => ({
  getSessionPolicy: (...args: unknown[]) => mockGetSessionPolicy(...args),
}));
vi.mock("@/lib/auth/session-validator", () => ({
  validateSession: (...args: unknown[]) => mockValidateSession(...args),
}));

let citingRows: Array<Record<string, unknown>> = [];
const customerPool = {
  query: vi.fn(async (_sql: string, _params?: unknown[]) => ({
    rows: citingRows,
  })),
};

vi.mock("@/lib/db/client", () => ({
  getAuthPool: () => ({ query: vi.fn() }),
  withTransaction: async (_pool: unknown, fn: (client: unknown) => unknown) =>
    fn({ query: vi.fn() }),
}));
vi.mock("@/lib/db/customer-runtime-pool", () => ({
  getCustomerRuntimePool: () => customerPool,
}));

const CUSTOMER_ID = "a0000000-0000-0000-0000-000000000001";

function citingRow(extra: Record<string, unknown> = {}) {
  return {
    period: "DAILY",
    bucket_date: "2026-05-26",
    tz: "Asia/Seoul",
    lang: "ENGLISH",
    model_name: "openai",
    model: "gpt-4o",
    generation: 3,
    priority_tier: "HIGH",
    requested_at: new Date("2026-05-27T12:00:00Z"),
    ...extra,
  };
}

async function callLoader(
  leaf: Parameters<
    typeof import("../cited-by-loader").loadCitedByReports
  >[0]["leaf"],
) {
  const mod = await import("../cited-by-loader");
  return mod.loadCitedByReports({ customerId: CUSTOMER_ID, leaf });
}

beforeEach(() => {
  vi.resetModules();
  customerPool.query.mockClear();
  citingRows = [];
  mockGetAuthCookie.mockReset().mockResolvedValue("auth-token");
  mockVerifyJwtFull
    .mockReset()
    .mockResolvedValue({ sub: "acc-1", sid: "sess-1" });
  mockAuthorize.mockReset().mockResolvedValue({ authorized: true });
  mockGetSessionPolicy.mockReset().mockResolvedValue({ general: {} });
  mockValidateSession
    .mockReset()
    .mockResolvedValue({ bridgeAiceId: null, bridgeCustomerIds: null });
});

describe("loadCitedByReports — permission gate", () => {
  it("returns an empty trail when the auth cookie is missing", async () => {
    mockGetAuthCookie.mockResolvedValue(null);
    expect(
      await callLoader({
        kind: "event",
        aiceId: "aice-9",
        eventKey: "777",
        generation: 4,
        modelName: "openai",
        model: "gpt-4o",
      }),
    ).toEqual([]);
    expect(customerPool.query).not.toHaveBeenCalled();
  });

  it("returns an empty trail when reports:read is denied (no leak)", async () => {
    mockAuthorize.mockResolvedValue({ authorized: false });
    citingRows = [citingRow()];
    expect(
      await callLoader({
        kind: "story",
        storyId: "555",
        generation: 2,
        modelName: "openai",
        model: "gpt-4o",
      }),
    ).toEqual([]);
    expect(customerPool.query).not.toHaveBeenCalled();
  });
});

describe("loadCitedByReports — query + shaping", () => {
  it("probes input_event_refs with the snake_case + generation + model shape for an event leaf", async () => {
    citingRows = [citingRow()];
    await callLoader({
      kind: "event",
      aiceId: "aice-9",
      eventKey: "777",
      generation: 4,
      modelName: "openai",
      model: "gpt-4o",
    });
    const [sql, params] = customerPool.query.mock.calls[0];
    // A single containment branch: exact match of the model-pinned ref.
    expect(String(sql)).toContain("input_event_refs @> $2::jsonb");
    expect(String(sql)).not.toContain("jsonb_array_elements");
    expect(params?.[0]).toBe(CUSTOMER_ID);
    // The probe pins `generation` AND the leaf's model so the trail only
    // matches reports that cited THIS generation of THIS model's leaf.
    expect(JSON.parse(String(params?.[1]))).toEqual([
      {
        aice_id: "aice-9",
        event_key: "777",
        generation: 4,
        model_name: "openai",
        model: "gpt-4o",
      },
    ]);
    // The probe and the customer scope are the only parameters.
    expect(params).toHaveLength(2);
  });

  it("probes input_story_refs with the generation + model pin for a story leaf", async () => {
    citingRows = [citingRow()];
    await callLoader({
      kind: "story",
      storyId: "555",
      generation: 2,
      modelName: "openai",
      model: "gpt-4o",
    });
    const [sql, params] = customerPool.query.mock.calls[0];
    expect(String(sql)).toContain("input_story_refs @> $2::jsonb");
    expect(JSON.parse(String(params?.[1]))).toEqual([
      {
        story_id: "555",
        generation: 2,
        model_name: "openai",
        model: "gpt-4o",
      },
    ]);
  });

  it("maps each citing row to a generation-pinned, locale-tagged entry", async () => {
    citingRows = [citingRow({ lang: "KOREAN", generation: 5 })];
    const out = await callLoader({
      kind: "story",
      storyId: "555",
      generation: 2,
      modelName: "openai",
      model: "gpt-4o",
    });
    expect(out).toEqual([
      {
        period: "DAILY",
        bucketDate: "2026-05-26",
        tz: "Asia/Seoul",
        locale: "ko",
        modelName: "openai",
        model: "gpt-4o",
        generation: 5,
        priorityTier: "HIGH",
        requestedAt: new Date("2026-05-27T12:00:00Z"),
      },
    ]);
  });

  it("dedupes per report bucket, keeping the newest-first representative", async () => {
    // Two language variants of the SAME bucket cite the leaf; the English
    // row is the most recent (rows arrive newest-first from the query), so
    // it represents the bucket and the Korean duplicate is dropped. A
    // second, older bucket follows it.
    citingRows = [
      citingRow({
        lang: "ENGLISH",
        generation: 4,
        requested_at: new Date("2026-05-27T12:00:00Z"),
      }),
      citingRow({
        lang: "KOREAN",
        generation: 3,
        requested_at: new Date("2026-05-27T11:00:00Z"),
      }),
      citingRow({
        period: "WEEKLY",
        bucket_date: "2026-05-24",
        generation: 1,
        requested_at: new Date("2026-05-24T09:00:00Z"),
      }),
    ];
    const out = await callLoader({
      kind: "story",
      storyId: "555",
      generation: 2,
      modelName: "openai",
      model: "gpt-4o",
    });
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({
      period: "DAILY",
      bucketDate: "2026-05-26",
      locale: "en",
      generation: 4,
    });
    expect(out[1]).toMatchObject({
      period: "WEEKLY",
      bucketDate: "2026-05-24",
    });
  });

  it("returns an empty trail when no report cites the leaf", async () => {
    citingRows = [];
    expect(
      await callLoader({
        kind: "story",
        storyId: "555",
        generation: 2,
        modelName: "openai",
        model: "gpt-4o",
      }),
    ).toEqual([]);
  });

  it("degrades to an empty trail when the reverse query throws", async () => {
    customerPool.query.mockRejectedValueOnce(new Error("db down"));
    expect(
      await callLoader({
        kind: "event",
        aiceId: "aice-9",
        eventKey: "777",
        generation: 4,
        modelName: "openai",
        model: "gpt-4o",
      }),
    ).toEqual([]);
  });
});
