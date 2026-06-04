// RFC 0003 P1a (#361) — evidence HMAC key-ring resolution.
//
// The evidence table stores only the keyed HMAC of each (dictionaryable)
// indicator, so a public default key would defeat that privacy property.
// `getEvidenceKeyRing` must fail closed in production when no key is
// configured, while still allowing a dev/test fallback.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

// The key ring is memoized per module instance; reset between cases so
// each one re-reads the env it stubs.
async function freshGetKeyRing() {
  vi.resetModules();
  const mod = await import("../enrichment-worker");
  return mod.getEvidenceKeyRing;
}

describe("getEvidenceKeyRing", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("throws in production when IOC_EVIDENCE_HMAC_KEY is unset", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("IOC_EVIDENCE_HMAC_KEY", "");
    const getEvidenceKeyRing = await freshGetKeyRing();
    expect(() => getEvidenceKeyRing()).toThrow(/IOC_EVIDENCE_HMAC_KEY/);
  });

  it("uses the configured key in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("IOC_EVIDENCE_HMAC_KEY", "prod-secret");
    vi.stubEnv("IOC_EVIDENCE_HMAC_KEY_VERSION", "v3");
    const getEvidenceKeyRing = await freshGetKeyRing();
    const ring = getEvidenceKeyRing();
    expect(ring.currentVersion).toBe("v3");
  });

  it("falls back to a dev key outside production", async () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("IOC_EVIDENCE_HMAC_KEY", "");
    const getEvidenceKeyRing = await freshGetKeyRing();
    expect(() => getEvidenceKeyRing()).not.toThrow();
  });
});
