import { afterEach, describe, expect, it, vi } from "vitest";

// Mock all 5 analyzers
const mockConsecutiveDenials = vi.fn().mockResolvedValue(0);
const mockSessionIpMismatch = vi.fn().mockResolvedValue(0);
const mockConcurrentMultiIp = vi.fn().mockResolvedValue(0);
const mockBridgeAbuse = vi.fn().mockResolvedValue(0);

vi.mock("../analyzers/consecutive-denials", () => ({
  analyzeConsecutiveDenials: (...args: unknown[]) =>
    mockConsecutiveDenials(...args),
}));
vi.mock("../analyzers/session-ip-mismatch", () => ({
  analyzeSessionIpMismatch: (...args: unknown[]) =>
    mockSessionIpMismatch(...args),
}));
vi.mock("../analyzers/concurrent-multi-ip", () => ({
  analyzeConcurrentMultiIp: (...args: unknown[]) =>
    mockConcurrentMultiIp(...args),
}));
vi.mock("../analyzers/bridge-abuse", () => ({
  analyzeBridgeAbuse: (...args: unknown[]) => mockBridgeAbuse(...args),
}));

vi.mock("server-only", () => ({}));

const { runAllAnalyzers } = await import("../analyzers/index");

// biome-ignore lint/suspicious/noExplicitAny: test mock
const fakePool = {} as any;

describe("runAllAnalyzers", () => {
  afterEach(() => {
    vi.resetAllMocks();
    mockConsecutiveDenials.mockResolvedValue(0);
    mockSessionIpMismatch.mockResolvedValue(0);
    mockConcurrentMultiIp.mockResolvedValue(0);
    mockBridgeAbuse.mockResolvedValue(0);
  });

  it("calls all 4 analyzers", async () => {
    await runAllAnalyzers(fakePool);

    expect(mockConsecutiveDenials).toHaveBeenCalledWith(fakePool);
    expect(mockSessionIpMismatch).toHaveBeenCalledWith(fakePool);
    expect(mockConcurrentMultiIp).toHaveBeenCalledWith(fakePool);
    expect(mockBridgeAbuse).toHaveBeenCalledWith(fakePool);
  });

  it("returns the sum of all analyzer counts", async () => {
    mockConsecutiveDenials.mockResolvedValue(2);
    mockSessionIpMismatch.mockResolvedValue(1);
    mockConcurrentMultiIp.mockResolvedValue(0);
    mockBridgeAbuse.mockResolvedValue(3);

    const total = await runAllAnalyzers(fakePool);
    expect(total).toBe(6);
  });

  it("continues running remaining analyzers when one fails", async () => {
    mockConsecutiveDenials.mockRejectedValue(new Error("DB error"));
    mockSessionIpMismatch.mockResolvedValue(1);
    mockBridgeAbuse.mockResolvedValue(2);

    const total = await runAllAnalyzers(fakePool);

    // Failed analyzer contributes 0, others succeed
    expect(total).toBe(3);
    // All analyzers still called
    expect(mockConcurrentMultiIp).toHaveBeenCalled();
    expect(mockBridgeAbuse).toHaveBeenCalled();
  });

  it("returns 0 when all analyzers return 0", async () => {
    const total = await runAllAnalyzers(fakePool);
    expect(total).toBe(0);
  });
});
