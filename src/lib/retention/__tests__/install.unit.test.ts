import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

vi.mock("../../audit", () => ({
  auditLog: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../db/client", () => ({
  getAuthPool: () => ({ query: vi.fn().mockResolvedValue({ rows: [] }) }),
}));

vi.mock("../../db/customer-runtime-pool", () => ({
  getCustomerRuntimePool: () => {
    throw new Error(
      "getCustomerRuntimePool must not be invoked from unit tests",
    );
  },
}));

const SLOT = Symbol.for("aimer.retention.sweeper");

function clearSlot(): void {
  delete (globalThis as Record<symbol, unknown>)[SLOT];
}

describe("installRetentionSweeper", () => {
  beforeEach(() => {
    clearSlot();
    vi.useFakeTimers();
    vi.resetModules();
  });

  afterEach(() => {
    vi.useRealTimers();
    clearSlot();
    delete process.env.RETENTION_SWEEP_INTERVAL_MS;
    vi.restoreAllMocks();
  });

  it("schedules exactly one interval per process", async () => {
    const { installRetentionSweeper, uninstallRetentionSweeper } = await import(
      "../sweeper"
    );

    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
    installRetentionSweeper();
    installRetentionSweeper();
    installRetentionSweeper();

    expect(setIntervalSpy).toHaveBeenCalledTimes(1);
    uninstallRetentionSweeper();
  });

  it("uses RETENTION_SWEEP_INTERVAL_MS when set", async () => {
    process.env.RETENTION_SWEEP_INTERVAL_MS = "30000";
    vi.resetModules();
    const { installRetentionSweeper, uninstallRetentionSweeper } = await import(
      "../sweeper"
    );

    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
    installRetentionSweeper();

    expect(setIntervalSpy).toHaveBeenCalledTimes(1);
    expect(setIntervalSpy.mock.calls[0][1]).toBe(30_000);
    uninstallRetentionSweeper();
  });

  it("falls back to the default interval on an invalid env value", async () => {
    process.env.RETENTION_SWEEP_INTERVAL_MS = "not-a-number";
    vi.resetModules();
    const { installRetentionSweeper, uninstallRetentionSweeper } = await import(
      "../sweeper"
    );

    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
    vi.spyOn(console, "warn").mockImplementation(() => {});
    installRetentionSweeper();

    expect(setIntervalSpy).toHaveBeenCalledTimes(1);
    expect(setIntervalSpy.mock.calls[0][1]).toBe(60 * 60 * 1000);
    uninstallRetentionSweeper();
  });

  it("uninstall clears the timer and a subsequent install re-arms it", async () => {
    const { installRetentionSweeper, uninstallRetentionSweeper } = await import(
      "../sweeper"
    );

    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
    installRetentionSweeper();
    uninstallRetentionSweeper();
    installRetentionSweeper();
    expect(setIntervalSpy).toHaveBeenCalledTimes(2);
    uninstallRetentionSweeper();
  });
});
