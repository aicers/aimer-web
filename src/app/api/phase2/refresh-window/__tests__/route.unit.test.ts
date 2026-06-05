import type { Pool } from "pg";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mocks
//
// Capture the `mutate` function the route hands to the shared mutation
// handler so we can invoke it directly and assert that the route loads
// the customer's redaction ranges and threads `customerId` + `ranges`
// into `executeWindowReplace`.
// ---------------------------------------------------------------------------

vi.mock("server-only", () => ({}));

let capturedMutate:
  | ((
      customerPool: Pool,
      verified: unknown,
      payload: unknown,
    ) => Promise<unknown>)
  | undefined;

vi.mock("../../_shared/mutation-handler", () => ({
  createPhase2MutationHandler: (config: {
    mutate: (
      customerPool: Pool,
      verified: unknown,
      payload: unknown,
    ) => Promise<unknown>;
  }) => {
    capturedMutate = config.mutate;
    return () => new Response();
  },
}));

const mockAuthPool = { kind: "auth" } as unknown as Pool;
vi.mock("@/lib/db/client", () => ({
  getAuthPool: () => mockAuthPool,
}));

const mockLoadCustomerRanges = vi.fn();
const mockLoadCustomerOwnedDomains = vi.fn();
vi.mock("@/lib/redaction", () => ({
  loadCustomerRanges: (...args: unknown[]) => mockLoadCustomerRanges(...args),
  loadCustomerOwnedDomains: (...args: unknown[]) =>
    mockLoadCustomerOwnedDomains(...args),
}));

const mockExecuteWindowReplace = vi.fn();
vi.mock("../../_shared/window-replace", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../_shared/window-replace")>();
  return {
    ...actual,
    executeWindowReplace: (...args: unknown[]) =>
      mockExecuteWindowReplace(...args),
  };
});

vi.mock("@/lib/analysis/ingest-hooks", () => ({
  applyWindowReplaceEnvelopeHook: vi.fn().mockResolvedValue(undefined),
  applyWindowReplaceStoryHook: vi.fn().mockResolvedValue(undefined),
}));

// Trigger the route module to register its mutate config.
await import("../route");

const fakeRanges = { __ranges: true } as unknown;
const fakeOwnedDomains = { __ownedDomains: true } as unknown;
const customerPool = { kind: "customer" } as unknown as Pool;

beforeEach(() => {
  vi.clearAllMocks();
  mockLoadCustomerRanges.mockResolvedValue(fakeRanges);
  mockLoadCustomerOwnedDomains.mockResolvedValue(fakeOwnedDomains);
  mockExecuteWindowReplace.mockResolvedValue({
    counts: { accepted: 1, deleted: 0 },
    extras: {
      kind: "baseline",
      baseline: {
        from: new Date("2026-01-01T00:00:00Z"),
        to: new Date("2026-01-01T01:00:00Z"),
        liveBaselineDeleted: false,
      },
    },
  });
});

describe("refresh-window route wiring", () => {
  it("loads customer ranges from the auth pool and threads customerId + ranges into executeWindowReplace", async () => {
    expect(capturedMutate).toBeDefined();

    const verified = {
      customerId: "11111111-2222-3333-4444-555555555555",
      envelopeClaims: { aiceId: "aice-1", eventCount: 1 },
    };
    const payload = {
      external_key: "ext",
      window: {
        kind: "baseline_event",
        from: "2026-01-01T00:00:00Z",
        to: "2026-01-01T01:00:00Z",
      },
      baseline_version: "v1",
      events: [],
    };

    await capturedMutate?.(customerPool, verified, payload);

    expect(mockLoadCustomerRanges).toHaveBeenCalledWith(
      mockAuthPool,
      verified.customerId,
    );
    expect(mockLoadCustomerOwnedDomains).toHaveBeenCalledWith(
      mockAuthPool,
      verified.customerId,
    );
    expect(mockExecuteWindowReplace).toHaveBeenCalledWith(
      customerPool,
      payload,
      verified.customerId,
      verified.envelopeClaims.aiceId,
      fakeRanges,
      fakeOwnedDomains,
    );
  });
});
