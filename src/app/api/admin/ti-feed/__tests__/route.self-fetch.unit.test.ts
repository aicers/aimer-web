// RFC 0003 F4 fan-out (#623) — GET /api/admin/ti-feed self-fetch cadence.
//
// The status route must compute `effectiveCadenceMs` / `nextFetchDueAt` /
// `dueNow` for a VENDOR-REPO source from its `vendorRepo` branch (default
// `VENDOR_REPO_DEFAULT_CADENCE_FLOOR_MS`), mirroring the worker — not only for
// flat `fetch` sources. Without that fix a fetchable vendor-repo source rendered
// `dueNow:false` / cadence "—" despite being self-fetched. Drives the route with
// the source-status loader + schedule reader mocked; the cadence math
// (`effectiveCadenceMs`) and the catalog lookup (`getTier1FeedSource`) run for
// real so the vendor-repo branch is exercised.

import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const SELF_ACCOUNT_ID = "00000000-0000-0000-0000-000000000099";

const mockAssertAuthorized = vi.fn();
const mockGetStatuses = vi.fn();
const mockReadSchedule = vi.fn();

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
  verifyOrigin: () => null,
  verifyCsrf: () => null,
}));

vi.mock("@/lib/auth/authorization", () => ({
  assertAuthorized: (...args: unknown[]) => mockAssertAuthorized(...args),
}));

vi.mock("@/lib/db/client", () => ({
  getAuthPool: vi.fn(() => ({
    connect: vi.fn(async () => ({ query: vi.fn(), release: vi.fn() })),
  })),
  getFeedPool: vi.fn(() => ({ query: vi.fn() })),
}));

// Force self-fetch mode + stub the source-status loader. The catalog lookup and
// the cadence math stay REAL so the vendor-repo cadence branch is exercised.
vi.mock("@/lib/analysis/enrichment/feed-fetch", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/lib/analysis/enrichment/feed-fetch")
    >();
  return {
    ...actual,
    tiFeedAdminSurfaceActive: () => true,
    selfFetchModeActive: () => true,
    getSelfFetchSourceStatuses: (...args: unknown[]) =>
      mockGetStatuses(...args),
  };
});

vi.mock("@/lib/analysis/enrichment/feed-schedule", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/lib/analysis/enrichment/feed-schedule")
    >();
  return {
    ...actual,
    readSelfFetchSchedule: (...args: unknown[]) => mockReadSchedule(...args),
  };
});

function makeGet(): NextRequest {
  return new NextRequest(new URL("http://localhost:3000/api/admin/ti-feed"), {
    method: "GET",
  });
}

const ONE_HOUR_MS = 60 * 60 * 1000;

function baseStatus(over: Record<string, unknown>) {
  return {
    label: "",
    fetchable: true,
    fetchUrl: null,
    authKeyRequired: false,
    authKeyName: null,
    authKeySet: false,
    present: false,
    stale: false,
    rowCount: 0,
    lastFetchedAt: null,
    lastAttemptAt: null,
    lastStatus: null,
    lastError: null,
    lastRowCount: null,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.TI_FEED_MODE = "self-fetch";
  mockAssertAuthorized.mockResolvedValue(new Set(["ti-feed:read"]));
  // No interval set ⇒ the effective cadence falls to each source's floor.
  mockReadSchedule.mockResolvedValue({ enabled: true });
});

describe("GET /api/admin/ti-feed (self-fetch) — vendor-repo cadence", () => {
  it("computes cadence / nextFetchDueAt / dueNow from the vendorRepo branch", async () => {
    mockGetStatuses.mockResolvedValue([
      baseStatus({
        sourcePolicyId: "unit42/threat-intel",
        label: "Palo Alto Unit 42 (Unlicense)",
        lastFetchedAt: null,
      }),
    ]);
    const { GET } = await import("../route");
    const res = await GET(makeGet());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.mode).toBe("self-fetch");
    const unit42 = body.sources.find(
      (s: { sourcePolicyId: string }) =>
        s.sourcePolicyId === "unit42/threat-intel",
    );
    // The vendor-repo floor (1 h default) drives the effective cadence — NOT a
    // null "—" the way a non-fetchable source renders.
    expect(unit42.effectiveCadenceMs).toBe(ONE_HOUR_MS);
    // Never fetched ⇒ due on the next tick.
    expect(unit42.dueNow).toBe(true);
    expect(unit42.nextFetchDueAt).toBeNull();
  });

  it("derives a concrete nextFetchDueAt and stays not-due within cadence", async () => {
    // The route computes `dueNow` against its real `now` (`new Date()`), so to
    // exercise the not-yet-due branch deterministically — independent of the
    // wall clock — the fetch time is placed in the future, putting
    // `lastFetchedAt + cadence` provably after `now`.
    const lastFetchedAt = "2099-01-01T00:00:00.000Z";
    mockGetStatuses.mockResolvedValue([
      baseStatus({
        sourcePolicyId: "unit42/threat-intel",
        label: "Palo Alto Unit 42 (Unlicense)",
        present: true,
        lastFetchedAt,
      }),
    ]);
    const { GET } = await import("../route");
    const res = await GET(makeGet());
    const body = await res.json();
    const unit42 = body.sources.find(
      (s: { sourcePolicyId: string }) =>
        s.sourcePolicyId === "unit42/threat-intel",
    );
    expect(unit42.effectiveCadenceMs).toBe(ONE_HOUR_MS);
    expect(unit42.dueNow).toBe(false);
    expect(unit42.nextFetchDueAt).toBe(
      new Date(new Date(lastFetchedAt).getTime() + ONE_HOUR_MS).toISOString(),
    );
  });

  it("reports dueNow once a fetched vendor repo's cadence has elapsed", async () => {
    // Last fetched far in the past, so `lastFetchedAt + cadence` is provably
    // before the route's real `now`. The worker would fetch it on the next tick
    // (`now >= allowedAt`), so the status route must report `dueNow:true` — not
    // `false` with a stale past `nextFetchDueAt`. Mirrors
    // self-fetch-worker.ts's `allowedAt === null || now >= allowedAt`.
    const lastFetchedAt = "2020-01-01T00:00:00.000Z";
    mockGetStatuses.mockResolvedValue([
      baseStatus({
        sourcePolicyId: "unit42/threat-intel",
        label: "Palo Alto Unit 42 (Unlicense)",
        present: true,
        lastFetchedAt,
      }),
    ]);
    const { GET } = await import("../route");
    const res = await GET(makeGet());
    const body = await res.json();
    const unit42 = body.sources.find(
      (s: { sourcePolicyId: string }) =>
        s.sourcePolicyId === "unit42/threat-intel",
    );
    expect(unit42.effectiveCadenceMs).toBe(ONE_HOUR_MS);
    expect(unit42.dueNow).toBe(true);
    expect(unit42.nextFetchDueAt).toBe(
      new Date(new Date(lastFetchedAt).getTime() + ONE_HOUR_MS).toISOString(),
    );
  });
});
