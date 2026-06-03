// Unit test for the server-side scope page loader (#390 / parent #386).
//
// Covers the WS1 server obligations the client provider cannot satisfy:
//   - no cookie / bad JWT / invalid session → unauthorized
//   - bridge session (server `bridgeAiceId` / `bridgeCustomerIds`) →
//     short-circuit, independent of any `?scope=`
//   - non-canonical `?scope=` → redirect to the canonical sorted form,
//     preserving the report-variant params already on the URL
//   - canonical / absent `?scope=` → ok with the resolved scope reaching
//     the page (rendering is WS2)

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mockGetAuthCookie = vi.fn();
const mockVerifyJwtFull = vi.fn();
const mockGetSessionPolicy = vi.fn();
const mockValidateSession = vi.fn();
const mockListAccessibleCustomers = vi.fn();

vi.mock("@/lib/auth/cookies", () => ({
  getAuthCookie: (...args: unknown[]) => mockGetAuthCookie(...args),
}));
vi.mock("@/lib/auth/jwt", () => ({
  verifyJwtFull: (...args: unknown[]) => mockVerifyJwtFull(...args),
}));
vi.mock("@/lib/auth/session-policy", () => ({
  getSessionPolicy: (...args: unknown[]) => mockGetSessionPolicy(...args),
}));
vi.mock("@/lib/auth/session-validator", () => ({
  validateSession: (...args: unknown[]) => mockValidateSession(...args),
}));
vi.mock("@/lib/auth/authorization", () => ({
  listAccessibleCustomers: (...args: unknown[]) =>
    mockListAccessibleCustomers(...args),
}));
vi.mock("@/lib/db/client", () => ({
  getAuthPool: () => ({}),
  withTransaction: async (_pool: unknown, fn: (client: unknown) => unknown) =>
    fn({ query: vi.fn() }),
}));

import { loadScopePage } from "../scope-page-loader";

const PATHNAME = "/en/reports";

function arm(opts?: {
  bridgeAiceId?: string | null;
  bridgeCustomerIds?: string[] | null;
  accessible?: string[];
}) {
  mockGetAuthCookie.mockResolvedValue("token");
  mockVerifyJwtFull.mockResolvedValue({ sub: "acc-1", sid: "sess-1" });
  mockGetSessionPolicy.mockResolvedValue({ general: {} });
  mockValidateSession.mockResolvedValue({
    bridgeAiceId: opts?.bridgeAiceId ?? null,
    bridgeCustomerIds: opts?.bridgeCustomerIds ?? null,
  });
  mockListAccessibleCustomers.mockResolvedValue(
    (opts?.accessible ?? ["c1", "c2", "c3"]).map((id) => ({
      id,
      name: id,
      externalKey: id,
    })),
  );
}

describe("loadScopePage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns unauthorized when there is no auth cookie", async () => {
    mockGetAuthCookie.mockResolvedValue(null);
    expect(
      await loadScopePage({ pathname: PATHNAME, searchParams: {} }),
    ).toEqual({ kind: "unauthorized" });
  });

  it("returns unauthorized when the JWT does not verify", async () => {
    mockGetAuthCookie.mockResolvedValue("token");
    mockVerifyJwtFull.mockRejectedValue(new Error("bad jwt"));
    expect(
      await loadScopePage({ pathname: PATHNAME, searchParams: {} }),
    ).toEqual({ kind: "unauthorized" });
  });

  it("returns unauthorized when the session is invalid", async () => {
    arm();
    mockValidateSession.mockRejectedValue(new Error("revoked"));
    expect(
      await loadScopePage({ pathname: PATHNAME, searchParams: {} }),
    ).toEqual({ kind: "unauthorized" });
  });

  it("short-circuits a bridge session off the server fields", async () => {
    arm({ bridgeAiceId: "env-1", bridgeCustomerIds: ["c1"] });
    // A bridge session is short-circuited regardless of the `?scope=` value
    // and never reads the accessible-customer set.
    const outcome = await loadScopePage({
      pathname: PATHNAME,
      searchParams: { scope: "c1,c2" },
    });
    expect(outcome).toEqual({ kind: "bridge" });
    expect(mockListAccessibleCustomers).not.toHaveBeenCalled();
  });

  it("resolves an absent scope to the all-scope (ok, no redirect)", async () => {
    arm();
    const outcome = await loadScopePage({
      pathname: PATHNAME,
      searchParams: {},
    });
    expect(outcome).toEqual({
      kind: "ok",
      scope: { isAll: true, customerIds: ["c1", "c2", "c3"], canonical: "all" },
    });
  });

  it("resolves a canonical subset to ok without redirecting", async () => {
    arm();
    const outcome = await loadScopePage({
      pathname: PATHNAME,
      searchParams: { scope: "c1,c2" },
    });
    expect(outcome).toEqual({
      kind: "ok",
      scope: { isAll: false, customerIds: ["c1", "c2"], canonical: "c1,c2" },
    });
  });

  it("redirects an unsorted scope to the canonical sorted form", async () => {
    arm();
    const outcome = await loadScopePage({
      pathname: PATHNAME,
      searchParams: { scope: "c2,c1" },
    });
    expect(outcome).toEqual({
      kind: "redirect",
      target: "/en/reports?scope=c1%2Cc2",
    });
  });

  it("redirects garbled / inaccessible scope to the all-scope", async () => {
    arm();
    const outcome = await loadScopePage({
      pathname: PATHNAME,
      searchParams: { scope: "garbage" },
    });
    expect(outcome).toEqual({
      kind: "redirect",
      target: "/en/reports?scope=all",
    });
  });

  it("preserves report-variant params when redirecting to canonical", async () => {
    arm();
    const outcome = await loadScopePage({
      pathname: PATHNAME,
      searchParams: { scope: "c2,c1", tz: "Asia/Seoul", lang: "ENGLISH" },
    });
    // mergeQuery sorts keys deterministically; scope is rewritten, the rest
    // carried through untouched.
    expect(outcome).toEqual({
      kind: "redirect",
      target: "/en/reports?lang=ENGLISH&scope=c1%2Cc2&tz=Asia%2FSeoul",
    });
  });
});
