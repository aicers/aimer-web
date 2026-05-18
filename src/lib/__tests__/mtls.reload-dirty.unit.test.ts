import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as jose from "jose";
import { decodeProtectedHeader } from "jose";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { EC256_CERT, EC256_KEY, RSA_CERT, RSA_KEY } from "./mtls-fixtures";

vi.mock("server-only", () => ({}));

// Passthrough mock so `importPKCS8` can be spied on. ESM namespace bindings
// are read-only by default; `vi.mock` replaces the module with a mutable
// object whose exports forward to the real implementation.
vi.mock("jose", async () => {
  const actual = await vi.importActual<typeof import("jose")>("jose");
  return { ...actual };
});

const EXPIRY_TIMER_SLOT = Symbol.for("aimer.mtls.expiryTimer");
const EXPIRY_WARN_SLOT = Symbol.for("aimer.mtls.expiryWarnedAt");
const EXPIRY_CURRENT_SLOT = Symbol.for("aimer.mtls.expiryCurrent");

let workDir: string;

function setEnv(certPem: string, keyPem: string): void {
  const certPath = join(workDir, "cert.pem");
  const keyPath = join(workDir, "key.pem");
  const caPath = join(workDir, "ca.pem");
  writeFileSync(certPath, certPem);
  writeFileSync(keyPath, keyPem);
  writeFileSync(caPath, certPem);
  process.env.MTLS_CERT_PATH = certPath;
  process.env.MTLS_KEY_PATH = keyPath;
  process.env.MTLS_CA_PATH = caPath;
}

function clearEnv(): void {
  delete process.env.MTLS_CERT_PATH;
  delete process.env.MTLS_KEY_PATH;
  delete process.env.MTLS_CA_PATH;
}

function clearGlobalSlots(): void {
  const g = globalThis as Record<symbol, unknown>;
  const timer = g[EXPIRY_TIMER_SLOT] as NodeJS.Timeout | undefined;
  if (timer) clearInterval(timer);
  delete g[EXPIRY_TIMER_SLOT];
  delete g[EXPIRY_WARN_SLOT];
  delete g[EXPIRY_CURRENT_SLOT];
}

describe("mtls reload() dirty re-run path", () => {
  let mtls: typeof import("@/lib/mtls");

  beforeEach(async () => {
    workDir = mkdtempSync(join(tmpdir(), "mtls-dirty-"));
    clearEnv();
    vi.resetModules();
    clearGlobalSlots();
    mtls = await import("@/lib/mtls");
  });

  afterEach(() => {
    clearEnv();
    clearGlobalSlots();
    vi.restoreAllMocks();
    rmSync(workDir, { recursive: true, force: true });
  });

  it("re-runs buildState() when a second reload() arrives mid-flight", async () => {
    setEnv(EC256_CERT, EC256_KEY);
    const l0 = await mtls.createMtlsRequestAuth({ sub: "u", aice_id: "a" });
    l0.release();
    expect(decodeProtectedHeader(l0.token).alg).toBe("ES256");

    // Pause the next importPKCS8 call so the first reload() hangs inside
    // buildState(). A second reload() arriving during that window must set
    // reloadDirty=true, and the do/while loop must re-run buildState()
    // against the (by-then swapped) on-disk material. Without the dirty
    // re-run, the final state would be the first (EC) build and the next
    // JWT would still be ES256-signed.
    const original = jose.importPKCS8;
    let release!: () => void;
    const pause = new Promise<void>((resolve) => {
      release = resolve;
    });
    const spy = vi
      .spyOn(jose, "importPKCS8")
      .mockImplementationOnce(async (pem, alg, options) => {
        const real = await original(pem, alg, options);
        await pause;
        return real;
      });

    const firstReload = mtls.reload();
    // Yield until buildState() reaches its awaited importPKCS8 call.
    while (spy.mock.calls.length === 0) {
      await new Promise((r) => setImmediate(r));
    }

    // Swap the on-disk material so the dirty re-run picks up RSA.
    setEnv(RSA_CERT, RSA_KEY);

    // Second reload() coalesces onto the in-flight promise AND sets
    // reloadDirty=true so the do/while loop re-runs buildState().
    const secondReload = mtls.reload();
    expect(secondReload).toBe(firstReload);

    // Unblock the paused importPKCS8 so the first build completes; the
    // loop then re-runs buildState() under the swapped env.
    release();
    await firstReload;

    // Final installed state must be the RSA one from the dirty re-run,
    // not the EC one from the original (paused) build.
    const l1 = await mtls.createMtlsRequestAuth({ sub: "u", aice_id: "a" });
    l1.release();
    expect(decodeProtectedHeader(l1.token).alg).toBe("RS256");

    // The do/while loop should have called buildState() twice: the hung
    // EC build plus the dirty re-run against RSA.
    expect(spy).toHaveBeenCalledTimes(2);
  });
});
