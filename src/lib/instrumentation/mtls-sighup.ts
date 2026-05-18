import "server-only";

/**
 * Reload mTLS materials when the process receives `SIGHUP`, so bootroot-driven
 * certificate rotation takes effect without restarting the Next.js server.
 *
 * Install is idempotent across re-invocation (HMR, repeated instrumentation
 * boots) via a `globalThis` slot. We track *our* installation specifically
 * rather than `process.listenerCount("SIGHUP")` because another module may
 * legitimately attach its own SIGHUP listener (e.g. a future graceful-shutdown
 * hook); a `listenerCount > 0` check would then incorrectly skip our
 * registration.
 */

const SIGHUP_SLOT = Symbol.for("aimer.mtls.sighup");

interface SighupSlot {
  installed: boolean;
  installing: Promise<void> | null;
}

type GlobalWithSighupSlot = typeof globalThis & {
  [SIGHUP_SLOT]?: SighupSlot;
};

function getSlot(): SighupSlot {
  const g = globalThis as GlobalWithSighupSlot;
  let slot = g[SIGHUP_SLOT];
  if (!slot) {
    slot = { installed: false, installing: null };
    g[SIGHUP_SLOT] = slot;
  }
  return slot;
}

export function installMtlsSighupHandler(): Promise<void> {
  const slot = getSlot();
  if (slot.installed) return Promise.resolve();
  if (slot.installing) return slot.installing;

  const installing = (async () => {
    const mtls = await import("@/lib/mtls");
    if (typeof mtls.reload !== "function") {
      throw new TypeError(
        "[mtls] SIGHUP install aborted: @/lib/mtls did not export a reload() function",
      );
    }
    process.on("SIGHUP", () => {
      mtls.reload().then(
        () => {
          console.info("[mtls] SIGHUP: reloaded mTLS materials");
        },
        (err) => {
          console.error("[mtls] SIGHUP: reload failed", err);
        },
      );
    });
    slot.installed = true;
  })();

  slot.installing = installing;
  // Clear the in-flight slot once the install settles. On success `installed`
  // is already true, so a subsequent call short-circuits. On failure
  // `installed` stays false and `installing` is cleared, so the caller can
  // retry. We attach this cleanup with a non-throwing handler so we never
  // create an unhandled rejection here; the caller still observes the
  // rejection via the returned promise.
  installing.then(
    () => {
      slot.installing = null;
    },
    () => {
      slot.installing = null;
    },
  );

  return installing;
}
