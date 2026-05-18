import { execSync } from "node:child_process";
import { createPrivateKey, X509Certificate } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { decodeJwt, decodeProtectedHeader, importSPKI, jwtVerify } from "jose";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  EC256_CERT,
  EC256_KEY,
  EC384_CERT,
  EC384_KEY,
  EC521_CERT,
  ED25519_CERT,
  RSA_CERT,
  RSA_KEY,
  RSA3072_CERT,
  RSA3072_KEY,
  RSA4096_CERT,
  RSA4096_KEY,
} from "./mtls-fixtures";

vi.mock("server-only", () => ({}));

const EXPIRY_TIMER_SLOT = Symbol.for("aimer.mtls.expiryTimer");
const EXPIRY_WARN_SLOT = Symbol.for("aimer.mtls.expiryWarnedAt");
const EXPIRY_CURRENT_SLOT = Symbol.for("aimer.mtls.expiryCurrent");

let workDir: string;

function setEnv(certPem: string, keyPem: string, caPem = certPem): void {
  const certPath = join(workDir, "cert.pem");
  const keyPath = join(workDir, "key.pem");
  const caPath = join(workDir, "ca.pem");
  writeFileSync(certPath, certPem);
  writeFileSync(keyPath, keyPem);
  writeFileSync(caPath, caPem);
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

function publicKeyFromCert(certPem: string): string {
  const x509 = new X509Certificate(certPem);
  return x509.publicKey.export({ type: "spki", format: "pem" }) as string;
}

function toPkcs1Rsa(pkcs8Pem: string): string {
  return createPrivateKey(pkcs8Pem).export({
    type: "pkcs1",
    format: "pem",
  }) as string;
}

function toSec1Ec(pkcs8Pem: string): string {
  return createPrivateKey(pkcs8Pem).export({
    type: "sec1",
    format: "pem",
  }) as string;
}

function makeShortLivedCert(days: number): { cert: string; key: string } {
  const dir = mkdtempSync(join(tmpdir(), "mtls-short-"));
  try {
    execSync(
      `openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 ` +
        `-keyout ${dir}/k.pem -out ${dir}/c.pem ` +
        `-days ${days} -nodes -subj "/CN=expiring"`,
      { stdio: "pipe" },
    );
    return {
      cert: readFileSync(`${dir}/c.pem`, "utf8"),
      key: readFileSync(`${dir}/k.pem`, "utf8"),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

type JwtAlgName = "RS256" | "ES256" | "ES384";

describe("mtls", () => {
  let mtls: typeof import("@/lib/mtls");

  beforeEach(async () => {
    workDir = mkdtempSync(join(tmpdir(), "mtls-test-"));
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

  // ── lazy import ──────────────────────────────────────────────────────────

  describe("module import", () => {
    it("does not load files at import time when env vars are unset", () => {
      // beforeEach has already cleared env vars and re-imported the module.
      // If buildState ran at import, it would have thrown.
      expect(mtls.createMtlsRequestAuth).toBeTypeOf("function");
      expect(mtls.reload).toBeTypeOf("function");
    });
  });

  // ── detectAlgorithm ──────────────────────────────────────────────────────

  describe("detectAlgorithm", () => {
    it("returns RS256 for RSA 2048 certificate", () => {
      expect(mtls.detectAlgorithm(RSA_CERT)).toBe("RS256");
    });
    it("returns RS384 for RSA 3072 certificate", () => {
      expect(mtls.detectAlgorithm(RSA3072_CERT)).toBe("RS384");
    });
    it("returns RS512 for RSA 4096 certificate", () => {
      expect(mtls.detectAlgorithm(RSA4096_CERT)).toBe("RS512");
    });
    it("returns ES256 for EC P-256 certificate", () => {
      expect(mtls.detectAlgorithm(EC256_CERT)).toBe("ES256");
    });
    it("returns ES384 for EC P-384 certificate", () => {
      expect(mtls.detectAlgorithm(EC384_CERT)).toBe("ES384");
    });
    it("throws for EC P-521 (intentionally unsupported)", () => {
      expect(() => mtls.detectAlgorithm(EC521_CERT)).toThrow(
        "Unsupported EC curve: secp521r1",
      );
    });
    it("throws for unsupported key type (Ed25519)", () => {
      expect(() => mtls.detectAlgorithm(ED25519_CERT)).toThrow(
        "Unsupported key type: ed25519",
      );
    });
  });

  // ── createMtlsRequestAuth ────────────────────────────────────────────────

  describe("createMtlsRequestAuth", () => {
    it("includes sub, aice_id, aud, jti, iat, exp", async () => {
      setEnv(EC256_CERT, EC256_KEY);
      const lease = await mtls.createMtlsRequestAuth({
        sub: "user-123",
        aice_id: "aice-abc",
      });
      lease.release();

      const payload = decodeJwt(lease.token);
      expect(payload.sub).toBe("user-123");
      expect(payload.aice_id).toBe("aice-abc");
      expect(payload.aud).toBe("aimer");
      expect(payload.aud).toBe(mtls.AIMER_AUDIENCE);
      expect(payload.jti).toBeTypeOf("string");
      expect((payload.jti as string).length).toBeGreaterThan(0);
      expect(payload.iat).toBeTypeOf("number");
      expect(payload.exp).toBeTypeOf("number");
    });

    it("sets exp - iat === 300 exactly", async () => {
      setEnv(EC256_CERT, EC256_KEY);
      const lease = await mtls.createMtlsRequestAuth({
        sub: "u",
        aice_id: "a",
      });
      lease.release();
      const payload = decodeJwt(lease.token);
      expect((payload.exp as number) - (payload.iat as number)).toBe(300);
    });

    it("does NOT include customer_ids in the payload", async () => {
      setEnv(EC256_CERT, EC256_KEY);
      const lease = await mtls.createMtlsRequestAuth({
        sub: "u",
        aice_id: "a",
      });
      lease.release();
      const payload = decodeJwt(lease.token);
      expect(payload).not.toHaveProperty("customer_ids");
    });

    it("generates a fresh jti per call", async () => {
      setEnv(EC256_CERT, EC256_KEY);
      const l1 = await mtls.createMtlsRequestAuth({ sub: "u", aice_id: "a" });
      const l2 = await mtls.createMtlsRequestAuth({ sub: "u", aice_id: "a" });
      l1.release();
      l2.release();
      expect(decodeJwt(l1.token).jti).not.toBe(decodeJwt(l2.token).jti);
    });

    it.each<[string, [string, string], JwtAlgName]>([
      ["RSA 2048 → RS256", [RSA_CERT, RSA_KEY], "RS256"],
      ["EC P-256 → ES256", [EC256_CERT, EC256_KEY], "ES256"],
      ["EC P-384 → ES384", [EC384_CERT, EC384_KEY], "ES384"],
    ])("signs with the cert-derived algorithm: %s", async (_label, pair, expected) => {
      setEnv(pair[0], pair[1]);
      const lease = await mtls.createMtlsRequestAuth({
        sub: "u",
        aice_id: "a",
      });
      lease.release();
      expect(decodeProtectedHeader(lease.token).alg).toBe(expected);
    });

    it("signs RS384 with RSA 3072 cert", async () => {
      setEnv(RSA3072_CERT, RSA3072_KEY);
      const lease = await mtls.createMtlsRequestAuth({
        sub: "u",
        aice_id: "a",
      });
      lease.release();
      expect(decodeProtectedHeader(lease.token).alg).toBe("RS384");
    });

    it("signs RS512 with RSA 4096 cert", async () => {
      setEnv(RSA4096_CERT, RSA4096_KEY);
      const lease = await mtls.createMtlsRequestAuth({
        sub: "u",
        aice_id: "a",
      });
      lease.release();
      expect(decodeProtectedHeader(lease.token).alg).toBe("RS512");
    });

    it("JWT verifies against the certificate's public key (ES256)", async () => {
      setEnv(EC256_CERT, EC256_KEY);
      const lease = await mtls.createMtlsRequestAuth({
        sub: "user-1",
        aice_id: "aice-1",
      });
      lease.release();

      const pub = await importSPKI(publicKeyFromCert(EC256_CERT), "ES256");
      const { payload } = await jwtVerify(lease.token, pub, {
        audience: "aimer",
      });
      expect(payload.sub).toBe("user-1");
      expect(payload.aice_id).toBe("aice-1");
    });

    it("JWT verifies against the certificate's public key (RS256)", async () => {
      setEnv(RSA_CERT, RSA_KEY);
      const lease = await mtls.createMtlsRequestAuth({
        sub: "u",
        aice_id: "a",
      });
      lease.release();

      const pub = await importSPKI(publicKeyFromCert(RSA_CERT), "RS256");
      const { payload } = await jwtVerify(lease.token, pub, {
        audience: "aimer",
      });
      expect(payload.aud).toBe("aimer");
    });
  });

  // ── reload ───────────────────────────────────────────────────────────────

  describe("reload", () => {
    it("rebuilds state and returns a fresh Agent", async () => {
      setEnv(EC256_CERT, EC256_KEY);
      const l1 = await mtls.createMtlsRequestAuth({ sub: "u", aice_id: "a" });
      l1.release();
      const before = l1.agent;
      const next = await mtls.reload();
      expect(next).not.toBe(before);
    });

    it("coalesces overlapping reload() calls", async () => {
      setEnv(EC256_CERT, EC256_KEY);
      const l = await mtls.createMtlsRequestAuth({ sub: "u", aice_id: "a" });
      l.release();
      const [a1, a2] = await Promise.all([mtls.reload(), mtls.reload()]);
      expect(a1).toBe(a2);
    });

    it("uses new key material after reload", async () => {
      setEnv(EC256_CERT, EC256_KEY);
      const l1 = await mtls.createMtlsRequestAuth({ sub: "u", aice_id: "a" });
      l1.release();
      expect(decodeProtectedHeader(l1.token).alg).toBe("ES256");

      setEnv(RSA_CERT, RSA_KEY);
      await mtls.reload();

      const l2 = await mtls.createMtlsRequestAuth({ sub: "u", aice_id: "a" });
      l2.release();
      expect(decodeProtectedHeader(l2.token).alg).toBe("RS256");
    });
  });

  // ── lease lifecycle ──────────────────────────────────────────────────────

  describe("lease lifecycle", () => {
    it("retired agent is closed only after the last lease releases", async () => {
      setEnv(EC256_CERT, EC256_KEY);
      const lease = await mtls.createMtlsRequestAuth({
        sub: "u",
        aice_id: "a",
      });
      const closeSpy = vi
        .spyOn(lease.agent, "close")
        .mockResolvedValue(undefined);

      await mtls.reload();
      expect(closeSpy).not.toHaveBeenCalled();

      lease.release();
      await new Promise((r) => setImmediate(r));
      expect(closeSpy).toHaveBeenCalledOnce();
    });

    it("release() is idempotent", async () => {
      setEnv(EC256_CERT, EC256_KEY);
      const lease = await mtls.createMtlsRequestAuth({
        sub: "u",
        aice_id: "a",
      });
      const closeSpy = vi
        .spyOn(lease.agent, "close")
        .mockResolvedValue(undefined);

      await mtls.reload();
      lease.release();
      lease.release();
      lease.release();
      await new Promise((r) => setImmediate(r));
      expect(closeSpy).toHaveBeenCalledOnce();
    });

    it("concurrent first-use init shares one Agent (single writer)", async () => {
      setEnv(EC256_CERT, EC256_KEY);
      const [a, b, c] = await Promise.all([
        mtls.createMtlsRequestAuth({ sub: "u", aice_id: "a" }),
        mtls.createMtlsRequestAuth({ sub: "u", aice_id: "b" }),
        mtls.createMtlsRequestAuth({ sub: "u", aice_id: "c" }),
      ]);
      expect(b.agent).toBe(a.agent);
      expect(c.agent).toBe(a.agent);
      a.release();
      b.release();
      c.release();
    });
  });

  // ── error handling ───────────────────────────────────────────────────────

  describe("error handling (env / files)", () => {
    it("throws when MTLS_CERT_PATH is missing", async () => {
      setEnv(EC256_CERT, EC256_KEY);
      delete process.env.MTLS_CERT_PATH;
      await expect(
        mtls.createMtlsRequestAuth({ sub: "u", aice_id: "a" }),
      ).rejects.toThrow("Missing environment variable: MTLS_CERT_PATH");
    });

    it("throws when MTLS_KEY_PATH is set to empty string", async () => {
      setEnv(EC256_CERT, EC256_KEY);
      process.env.MTLS_KEY_PATH = "";
      await expect(
        mtls.createMtlsRequestAuth({ sub: "u", aice_id: "a" }),
      ).rejects.toThrow("Missing environment variable: MTLS_KEY_PATH");
    });

    it("throws when MTLS_CA_PATH is missing", async () => {
      setEnv(EC256_CERT, EC256_KEY);
      delete process.env.MTLS_CA_PATH;
      await expect(
        mtls.createMtlsRequestAuth({ sub: "u", aice_id: "a" }),
      ).rejects.toThrow("Missing environment variable: MTLS_CA_PATH");
    });

    it("throws when the cert file does not exist", async () => {
      process.env.MTLS_CERT_PATH = join(workDir, "no-such-cert.pem");
      process.env.MTLS_KEY_PATH = join(workDir, "no-such-key.pem");
      process.env.MTLS_CA_PATH = join(workDir, "no-such-ca.pem");
      await expect(
        mtls.createMtlsRequestAuth({ sub: "u", aice_id: "a" }),
      ).rejects.toThrow(/ENOENT/);
    });
  });

  describe("error handling (cert / key relationship)", () => {
    it("rejects algorithm mismatch (cert EC, key RSA)", async () => {
      setEnv(EC256_CERT, RSA_KEY);
      await expect(
        mtls.createMtlsRequestAuth({ sub: "u", aice_id: "a" }),
      ).rejects.toThrow(
        /algorithm mismatch.*private key is rsa.*certificate is ec/i,
      );
    });

    it("rejects algorithm mismatch (cert RSA, key EC)", async () => {
      setEnv(RSA_CERT, EC256_KEY);
      await expect(
        mtls.createMtlsRequestAuth({ sub: "u", aice_id: "a" }),
      ).rejects.toThrow(
        /algorithm mismatch.*private key is ec.*certificate is rsa/i,
      );
    });

    it("rejects cert/key pair mismatch (same algorithm, different key)", async () => {
      setEnv(RSA_CERT, RSA3072_KEY);
      await expect(
        mtls.createMtlsRequestAuth({ sub: "u", aice_id: "a" }),
      ).rejects.toThrow(/does not match the certificate/i);
    });
  });

  // ── private-key format normalization ─────────────────────────────────────

  describe("private-key format normalization", () => {
    it("loads PKCS#1 RSA private key (BEGIN RSA PRIVATE KEY)", async () => {
      const pkcs1 = toPkcs1Rsa(RSA_KEY);
      expect(pkcs1).toContain("BEGIN RSA PRIVATE KEY");
      setEnv(RSA_CERT, pkcs1);
      const lease = await mtls.createMtlsRequestAuth({
        sub: "u",
        aice_id: "a",
      });
      lease.release();
      expect(decodeProtectedHeader(lease.token).alg).toBe("RS256");
    });

    it("loads SEC1 EC private key (BEGIN EC PRIVATE KEY)", async () => {
      const sec1 = toSec1Ec(EC256_KEY);
      expect(sec1).toContain("BEGIN EC PRIVATE KEY");
      setEnv(EC256_CERT, sec1);
      const lease = await mtls.createMtlsRequestAuth({
        sub: "u",
        aice_id: "a",
      });
      lease.release();
      expect(decodeProtectedHeader(lease.token).alg).toBe("ES256");
    });
  });

  // ── expiry monitoring ────────────────────────────────────────────────────

  describe("certificate expiry monitoring", () => {
    it("installs the expiry timer at most once across buildState calls", async () => {
      setEnv(EC256_CERT, EC256_KEY);
      const setIntervalSpy = vi.spyOn(globalThis, "setInterval");

      const l1 = await mtls.createMtlsRequestAuth({ sub: "u", aice_id: "a" });
      l1.release();
      await mtls.reload();
      await mtls.reload();
      const l2 = await mtls.createMtlsRequestAuth({ sub: "u", aice_id: "a" });
      l2.release();

      expect(setIntervalSpy).toHaveBeenCalledTimes(1);
    });

    it("does not re-install the timer on module re-import (HMR guard)", async () => {
      setEnv(EC256_CERT, EC256_KEY);
      const setIntervalSpy = vi.spyOn(globalThis, "setInterval");

      const l1 = await mtls.createMtlsRequestAuth({ sub: "u", aice_id: "a" });
      l1.release();
      expect(setIntervalSpy).toHaveBeenCalledTimes(1);

      // Simulate HMR: re-import the module without clearing the global slot.
      vi.resetModules();
      const mtls2 = await import("@/lib/mtls");
      const l2 = await mtls2.createMtlsRequestAuth({
        sub: "u",
        aice_id: "a",
      });
      l2.release();

      expect(setIntervalSpy).toHaveBeenCalledTimes(1);
    });

    it("timer warns on the cert loaded after HMR re-import, not a stale one", async () => {
      // Regression test for the stale-closure bug: the timer is installed
      // once in a global slot, but the cert it checks must be the one
      // most recently loaded by buildState(), not the one captured by the
      // first module instance that installed the timer.
      const certA = makeShortLivedCert(2);
      setEnv(certA.cert, certA.key, certA.cert);

      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const l1 = await mtls.createMtlsRequestAuth({ sub: "u", aice_id: "a" });
      l1.release();

      const fingerprintA = new X509Certificate(certA.cert).fingerprint256;
      expect(
        warnSpy.mock.calls.some((c) => String(c[0]).includes(fingerprintA)),
      ).toBe(true);

      // Simulate HMR re-evaluation: clear the dedup record (a real new cert
      // would have a different fingerprint anyway) and replace the module.
      const g = globalThis as Record<symbol, unknown>;
      delete g[EXPIRY_WARN_SLOT];
      vi.resetModules();
      const mtls2 = await import("@/lib/mtls");

      // Load a DIFFERENT short-lived cert in the new module instance.
      const certB = makeShortLivedCert(2);
      setEnv(certB.cert, certB.key, certB.cert);
      const l2 = await mtls2.createMtlsRequestAuth({ sub: "u", aice_id: "a" });
      l2.release();

      const fingerprintB = new X509Certificate(certB.cert).fingerprint256;
      expect(fingerprintB).not.toBe(fingerprintA);

      // Reset the warn dedup so the next timer tick can fire.
      delete g[EXPIRY_WARN_SLOT];
      warnSpy.mockClear();

      // Drive the (original, surviving) timer's callback. With the fix it
      // reads the global EXPIRY_CURRENT_SLOT updated by mtls2.buildState()
      // and warns about cert B. With the bug it would close over the old
      // module's `state` and warn about cert A (or miss entirely).
      const timer = g[EXPIRY_TIMER_SLOT] as
        | (NodeJS.Timeout & { _onTimeout?: () => void })
        | undefined;
      expect(timer).toBeDefined();
      const onTimeout = (timer as unknown as { _onTimeout: () => void })
        ._onTimeout;
      onTimeout();

      const messages = warnSpy.mock.calls.map((c) => String(c[0]));
      expect(messages.some((m) => m.includes(fingerprintB))).toBe(true);
      expect(messages.some((m) => m.includes(fingerprintA))).toBe(false);
    });

    it("warns at most once per 24h within the 3-day window", async () => {
      const { cert, key } = makeShortLivedCert(2);
      setEnv(cert, key, cert);
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      const lease = await mtls.createMtlsRequestAuth({
        sub: "u",
        aice_id: "a",
      });
      lease.release();

      const matchExpiry = (calls: unknown[][]): number =>
        calls.filter((c) =>
          String(c[0]).includes("[mtls] client certificate expires"),
        ).length;

      expect(matchExpiry(warnSpy.mock.calls)).toBe(1);

      // Drive the timer callback directly. Node's Timeout exposes
      // _onTimeout for setTimeout/setInterval — call it to simulate a tick
      // without waiting 6 hours of wall time.
      const g = globalThis as Record<symbol, unknown>;
      const timer = g[EXPIRY_TIMER_SLOT] as
        | (NodeJS.Timeout & { _onTimeout?: () => void })
        | undefined;
      expect(timer).toBeDefined();
      const onTimeout = (timer as unknown as { _onTimeout: () => void })
        ._onTimeout;
      onTimeout();
      onTimeout();
      onTimeout();

      expect(matchExpiry(warnSpy.mock.calls)).toBe(1);
    });
  });
});
