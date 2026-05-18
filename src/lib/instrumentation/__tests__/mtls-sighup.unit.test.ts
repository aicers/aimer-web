import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { reloadMock } = vi.hoisted(() => ({
  reloadMock: vi.fn<() => Promise<unknown>>(),
}));

vi.mock("@/lib/mtls", () => ({
  reload: (...args: unknown[]) => reloadMock(...(args as [])),
}));

const SIGHUP_SLOT = Symbol.for("aimer.mtls.sighup");

type SighupSlot = {
  installed: boolean;
  installing: Promise<void> | null;
};

function clearSighupSlot(): void {
  delete (globalThis as Record<symbol, unknown>)[SIGHUP_SLOT];
}

function getSlot(): SighupSlot | undefined {
  return (globalThis as Record<symbol, unknown>)[SIGHUP_SLOT] as
    | SighupSlot
    | undefined;
}

function snapshotSighupListeners(): NodeJS.SignalsListener[] {
  return [
    ...(process.listeners("SIGHUP") as unknown as NodeJS.SignalsListener[]),
  ];
}

function listenersAddedSince(
  before: NodeJS.SignalsListener[],
): NodeJS.SignalsListener[] {
  const current = process.listeners(
    "SIGHUP",
  ) as unknown as NodeJS.SignalsListener[];
  return current.filter((l) => !before.includes(l));
}

function removeListenersAddedSince(before: NodeJS.SignalsListener[]): void {
  for (const l of listenersAddedSince(before)) {
    process.off("SIGHUP", l);
  }
}

describe("installMtlsSighupHandler", () => {
  let listenersBefore: NodeJS.SignalsListener[];

  beforeEach(() => {
    clearSighupSlot();
    vi.resetModules();
    reloadMock.mockReset();
    reloadMock.mockResolvedValue(undefined);
    listenersBefore = snapshotSighupListeners();
  });

  afterEach(() => {
    removeListenersAddedSince(listenersBefore);
    clearSighupSlot();
    vi.restoreAllMocks();
  });

  it("registers a single SIGHUP listener on first install", async () => {
    const { installMtlsSighupHandler } = await import("../mtls-sighup");
    await installMtlsSighupHandler();
    expect(listenersAddedSince(listenersBefore)).toHaveLength(1);
  });

  it("is idempotent across sequential calls (HMR-like re-invocation)", async () => {
    const { installMtlsSighupHandler } = await import("../mtls-sighup");
    await installMtlsSighupHandler();
    await installMtlsSighupHandler();
    await installMtlsSighupHandler();
    expect(listenersAddedSince(listenersBefore)).toHaveLength(1);
  });

  it("joins a shared installing promise across concurrent calls", async () => {
    const { installMtlsSighupHandler } = await import("../mtls-sighup");
    await Promise.all([
      installMtlsSighupHandler(),
      installMtlsSighupHandler(),
      installMtlsSighupHandler(),
    ]);
    expect(listenersAddedSince(listenersBefore)).toHaveLength(1);
  });

  it("calls reload() exactly once per SIGHUP signal", async () => {
    const { installMtlsSighupHandler } = await import("../mtls-sighup");
    await installMtlsSighupHandler();
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});

    process.emit("SIGHUP");
    // Flush microtasks created inside the listener.
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(reloadMock).toHaveBeenCalledTimes(1);
    expect(infoSpy).toHaveBeenCalledWith(
      "[mtls] SIGHUP: reloaded mTLS materials",
    );
  });

  it("logs reload failure via console.error without crashing", async () => {
    const { installMtlsSighupHandler } = await import("../mtls-sighup");
    await installMtlsSighupHandler();

    const boom = new Error("disk read failed");
    reloadMock.mockReset();
    reloadMock.mockRejectedValueOnce(boom);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    process.emit("SIGHUP");
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(reloadMock).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledWith("[mtls] SIGHUP: reload failed", boom);
  });

  it("rejects and allows retry when import('@/lib/mtls') fails", async () => {
    vi.resetModules();
    vi.doMock("@/lib/mtls", () => {
      throw new Error("simulated import failure");
    });
    const failingMod = await import("../mtls-sighup");
    await expect(failingMod.installMtlsSighupHandler()).rejects.toBeInstanceOf(
      Error,
    );

    expect(listenersAddedSince(listenersBefore)).toHaveLength(0);

    const slot = getSlot();
    expect(slot?.installed).toBe(false);
    expect(slot?.installing).toBe(null);

    // Repair the import and retry: the next call must succeed and attach the
    // single listener.
    vi.resetModules();
    vi.doUnmock("@/lib/mtls");
    vi.doMock("@/lib/mtls", () => ({
      reload: (...args: unknown[]) => reloadMock(...(args as [])),
    }));
    const retryMod = await import("../mtls-sighup");
    await retryMod.installMtlsSighupHandler();

    expect(listenersAddedSince(listenersBefore)).toHaveLength(1);
    expect(getSlot()?.installed).toBe(true);
  });

  it("resolves reload() dynamically so HMR re-evaluations of @/lib/mtls take effect", async () => {
    const { installMtlsSighupHandler } = await import("../mtls-sighup");
    await installMtlsSighupHandler();

    // Simulate an HMR-like re-evaluation: `@/lib/mtls` is re-mocked with a
    // *different* reload implementation. The previously attached SIGHUP
    // listener must call the new reload, not the one captured at install.
    const freshReload = vi
      .fn<() => Promise<unknown>>()
      .mockResolvedValue(undefined);
    vi.resetModules();
    vi.doMock("@/lib/mtls", () => ({ reload: freshReload }));

    // Sanity-check that the dynamic import inside this test resolves to the
    // re-mocked namespace; if Vitest's module resolver wires this through to
    // the listener's `await import("@/lib/mtls")` correctly, the listener
    // will see the same fresh namespace at SIGHUP time.
    const probe = await import("@/lib/mtls");
    expect(probe.reload).toBe(freshReload);

    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    process.emit("SIGHUP");
    // The listener does `await import("@/lib/mtls")` then `await reload()`;
    // flush several macrotasks so both awaits settle before assertions.
    for (let i = 0; i < 5; i++) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }

    expect(errorSpy).not.toHaveBeenCalled();
    expect(freshReload).toHaveBeenCalledTimes(1);
    expect(reloadMock).not.toHaveBeenCalled();
    expect(infoSpy).toHaveBeenCalledWith(
      "[mtls] SIGHUP: reloaded mTLS materials",
    );
  });

  it("rejects with TypeError when @/lib/mtls exposes reload as undefined", async () => {
    vi.resetModules();
    vi.doMock("@/lib/mtls", () => ({ reload: undefined }));
    const mod = await import("../mtls-sighup");

    await expect(mod.installMtlsSighupHandler()).rejects.toBeInstanceOf(
      TypeError,
    );

    expect(listenersAddedSince(listenersBefore)).toHaveLength(0);

    const slot = getSlot();
    expect(slot?.installed).toBe(false);
    expect(slot?.installing).toBe(null);
  });
});
