import { afterEach, describe, expect, it, vi } from "vitest";

// Mock insertAlert before importing analyzers
const mockInsertAlert = vi.fn();
vi.mock("..", () => ({
  insertAlert: (...args: unknown[]) => mockInsertAlert(...args),
}));

vi.mock("server-only", () => ({}));

const { analyzeConsecutiveDenials } = await import(
  "../analyzers/consecutive-denials"
);
const { analyzeSessionIpMismatch } = await import(
  "../analyzers/session-ip-mismatch"
);
const { analyzeConcurrentMultiIp } = await import(
  "../analyzers/concurrent-multi-ip"
);
const { analyzeBridgeAbuse } = await import("../analyzers/bridge-abuse");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockPool(queryResults: Record<string, unknown>) {
  const callIndex = { value: 0 };
  const results = Object.values(queryResults);
  return {
    query: vi.fn().mockImplementation(() => {
      const idx = callIndex.value++;
      return results[idx] ?? { rows: [] };
    }),
    // biome-ignore lint/suspicious/noExplicitAny: test mock
  } as any;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("analyzeConsecutiveDenials", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("creates alert when threshold is met (by actor)", async () => {
    const pool = mockPool({
      byActor: {
        rows: [
          {
            actor_id: "actor-1",
            ip_address: "10.0.0.1",
            denial_count: 5,
            log_ids: ["1", "2", "3", "4", "5"],
          },
        ],
      },
      dedupActor: { rows: [] }, // no duplicate
      byIp: { rows: [] },
    });

    const count = await analyzeConsecutiveDenials(pool);
    expect(count).toBe(1);
    expect(mockInsertAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        indicator: "consecutive_sign_in_denials",
        actorId: "actor-1",
        ipAddress: "10.0.0.1",
        summary: expect.objectContaining({
          denialCount: 5,
          groupedBy: "actor_id",
        }),
        auditLogIds: [1, 2, 3, 4, 5],
      }),
    );
  });

  it("skips when duplicate exists within cooldown", async () => {
    const pool = mockPool({
      byActor: {
        rows: [
          {
            actor_id: "actor-1",
            ip_address: "10.0.0.1",
            denial_count: 5,
            log_ids: ["1", "2", "3", "4", "5"],
          },
        ],
      },
      dedupActor: { rows: [{ "?column?": 1 }] }, // duplicate exists
      byIp: { rows: [] },
    });

    const count = await analyzeConsecutiveDenials(pool);
    expect(count).toBe(0);
    expect(mockInsertAlert).not.toHaveBeenCalled();
  });

  it("returns 0 when no denials exceed threshold", async () => {
    const pool = mockPool({
      byActor: { rows: [] },
      byIp: { rows: [] },
    });

    const count = await analyzeConsecutiveDenials(pool);
    expect(count).toBe(0);
    expect(mockInsertAlert).not.toHaveBeenCalled();
  });

  it("creates alert by IP when threshold is met", async () => {
    const pool = mockPool({
      byActor: { rows: [] },
      byIp: {
        rows: [
          {
            ip_address: "10.0.0.99",
            denial_count: 7,
            log_ids: ["10", "11", "12", "13", "14", "15", "16"],
          },
        ],
      },
      dedupIp: { rows: [] },
    });

    const count = await analyzeConsecutiveDenials(pool);
    expect(count).toBe(1);
    expect(mockInsertAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        ipAddress: "10.0.0.99",
        summary: expect.objectContaining({ groupedBy: "ip_address" }),
      }),
    );
  });
});

describe("analyzeSessionIpMismatch", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("creates alert when mismatch threshold is met", async () => {
    const pool = mockPool({
      detect: {
        rows: [
          {
            actor_id: "actor-2",
            sid: "sid-2",
            ip_address: "10.0.0.2",
            mismatch_count: 3,
            log_ids: ["20", "21", "22"],
          },
        ],
      },
      dedup: { rows: [] },
    });

    const count = await analyzeSessionIpMismatch(pool);
    expect(count).toBe(1);
    expect(mockInsertAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        indicator: "session_ip_mismatch",
        actorId: "actor-2",
        summary: expect.objectContaining({ sid: "sid-2", mismatchCount: 3 }),
      }),
    );
  });

  it("returns 0 when no mismatches exceed threshold", async () => {
    const pool = mockPool({ detect: { rows: [] } });
    const count = await analyzeSessionIpMismatch(pool);
    expect(count).toBe(0);
  });

  it("skips duplicate within cooldown", async () => {
    const pool = mockPool({
      detect: {
        rows: [
          {
            actor_id: "actor-2",
            sid: "sid-2",
            ip_address: "10.0.0.2",
            mismatch_count: 3,
            log_ids: ["20", "21", "22"],
          },
        ],
      },
      dedup: { rows: [{ "?column?": 1 }] },
    });

    const count = await analyzeSessionIpMismatch(pool);
    expect(count).toBe(0);
    expect(mockInsertAlert).not.toHaveBeenCalled();
  });
});

describe("analyzeConcurrentMultiIp", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("creates alert for multi-IP sign-ins", async () => {
    const pool = mockPool({
      detect: {
        rows: [
          {
            actor_id: "actor-3",
            ip_count: 3,
            ips: ["10.0.0.1", "10.0.0.2", "10.0.0.3"],
            log_ids: ["30", "31", "32"],
          },
        ],
      },
      dedup: { rows: [] },
    });

    const count = await analyzeConcurrentMultiIp(pool);
    expect(count).toBe(1);
    expect(mockInsertAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        indicator: "concurrent_multi_ip_sessions",
        actorId: "actor-3",
        summary: expect.objectContaining({
          ipCount: 3,
          ips: ["10.0.0.1", "10.0.0.2", "10.0.0.3"],
        }),
      }),
    );
  });

  it("returns 0 when no concurrent sessions", async () => {
    const pool = mockPool({ detect: { rows: [] } });
    const count = await analyzeConcurrentMultiIp(pool);
    expect(count).toBe(0);
    expect(mockInsertAlert).not.toHaveBeenCalled();
  });

  it("skips duplicate within cooldown", async () => {
    const pool = mockPool({
      detect: {
        rows: [
          {
            actor_id: "actor-3",
            ip_count: 2,
            ips: ["10.0.0.1", "10.0.0.2"],
            log_ids: ["30", "31"],
          },
        ],
      },
      dedup: { rows: [{ "?column?": 1 }] },
    });

    const count = await analyzeConcurrentMultiIp(pool);
    expect(count).toBe(0);
    expect(mockInsertAlert).not.toHaveBeenCalled();
  });
});

describe("analyzeBridgeAbuse", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("creates alert for frequent bridge requests", async () => {
    const pool = mockPool({
      detect: {
        rows: [
          {
            aice_id: "aice.example.com",
            request_count: 15,
            log_ids: ["40", "41", "42"],
          },
        ],
      },
      dedup: { rows: [] },
    });

    const count = await analyzeBridgeAbuse(pool);
    expect(count).toBe(1);
    expect(mockInsertAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        indicator: "bridge_abuse",
        summary: expect.objectContaining({
          aiceId: "aice.example.com",
          requestCount: 15,
        }),
      }),
    );
  });

  it("returns 0 when no bridge abuse detected", async () => {
    const pool = mockPool({ detect: { rows: [] } });
    const count = await analyzeBridgeAbuse(pool);
    expect(count).toBe(0);
    expect(mockInsertAlert).not.toHaveBeenCalled();
  });

  it("skips duplicate within cooldown", async () => {
    const pool = mockPool({
      detect: {
        rows: [
          {
            aice_id: "aice.example.com",
            request_count: 15,
            log_ids: ["40", "41", "42"],
          },
        ],
      },
      dedup: { rows: [{ "?column?": 1 }] },
    });

    const count = await analyzeBridgeAbuse(pool);
    expect(count).toBe(0);
    expect(mockInsertAlert).not.toHaveBeenCalled();
  });
});
