import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mockCleanupPAR = vi.fn<(pool: unknown) => Promise<number>>();
const mockExpireStagedEvents = vi.fn<(pool: unknown) => Promise<number>>();
const mockCleanupTerminalPayloads = vi.fn<(pool: unknown) => Promise<number>>();
const mockCleanupExpiredConnections =
  vi.fn<(pool: unknown) => Promise<number>>();

vi.mock("@/lib/auth/analyze-bridge", () => ({
  cleanupExpiredAnalyzeRequests: (pool: unknown) => mockCleanupPAR(pool),
}));
vi.mock("@/lib/auth/bridge", () => ({
  cleanupExpiredConnections: (pool: unknown) =>
    mockCleanupExpiredConnections(pool),
}));
vi.mock("@/lib/auth/staged-events", () => ({
  cleanupTerminalPayloads: (pool: unknown) => mockCleanupTerminalPayloads(pool),
  expireStagedEvents: (pool: unknown) => mockExpireStagedEvents(pool),
}));
vi.mock("@/lib/db/client", () => ({
  getAuthPool: () => ({}),
}));

const { runCleanupTickForTests } = await import("../auth-pool-cleanup");

describe("auth-pool-cleanup tick", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCleanupPAR.mockResolvedValue(0);
    mockExpireStagedEvents.mockResolvedValue(0);
    mockCleanupTerminalPayloads.mockResolvedValue(0);
    mockCleanupExpiredConnections.mockResolvedValue(0);
  });

  it("invokes helpers in FK-safe order: PAR → expireStagedEvents → terminalPayloads → connections", async () => {
    const order: string[] = [];
    mockCleanupPAR.mockImplementation(async () => {
      order.push("par");
      return 0;
    });
    mockExpireStagedEvents.mockImplementation(async () => {
      order.push("expire");
      return 0;
    });
    mockCleanupTerminalPayloads.mockImplementation(async () => {
      order.push("terminal");
      return 0;
    });
    mockCleanupExpiredConnections.mockImplementation(async () => {
      order.push("connections");
      return 0;
    });

    await runCleanupTickForTests();

    expect(order).toEqual(["par", "expire", "terminal", "connections"]);
  });

  it("runs expireStagedEvents so a stale Phase 1 pending-customer row no longer wedges connection cleanup", async () => {
    // Simulate: a stale Phase 1 staged payload exists. Without
    // expireStagedEvents, its customer rows would stay in `pending`,
    // cleanupTerminalPayloads would refuse to delete the payload, and
    // cleanupExpiredConnections would FK-fail. With this PR, the tick
    // walks: PAR → expire customers → drop terminal payloads → drop
    // connections.
    let stalePayloadDeleted = false;
    mockExpireStagedEvents.mockImplementation(async () => 3);
    mockCleanupTerminalPayloads.mockImplementation(async () => {
      // expireStagedEvents already flipped customers to expired in (2),
      // so the terminal-payload sweep is unblocked.
      stalePayloadDeleted = mockExpireStagedEvents.mock.calls.length > 0;
      return 1;
    });
    mockCleanupExpiredConnections.mockImplementation(async () => 1);

    await runCleanupTickForTests();

    expect(mockExpireStagedEvents).toHaveBeenCalled();
    expect(stalePayloadDeleted).toBe(true);
    expect(mockCleanupExpiredConnections).toHaveBeenCalled();
  });

  it("isolates errors per step — a failing helper does not abort the rest of the tick", async () => {
    mockExpireStagedEvents.mockRejectedValueOnce(new Error("boom"));
    // Silence the console.error spam the catch produces in this test.
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await runCleanupTickForTests();

    expect(mockCleanupTerminalPayloads).toHaveBeenCalled();
    expect(mockCleanupExpiredConnections).toHaveBeenCalled();

    errSpy.mockRestore();
  });
});
