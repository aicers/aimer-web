import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";

// Mock server-only before importing the module
vi.mock("server-only", () => ({}));

// Mock the DB client
const mockQuery = vi.fn();
vi.mock("../../db/client", () => ({
  query: (...args: unknown[]) => mockQuery(...args),
}));

import {
  invalidateTrustRegistryCache,
  lookupTrustRegistryKey,
} from "../trust-registry";

const fakePool = {} as Parameters<typeof lookupTrustRegistryKey>[0];

const sampleKey: JsonWebKey = {
  kty: "EC",
  crv: "P-256",
  x: "f83OJ3D2xF1Bg8vub9tLe1gHMzV76e8Tus9uPHvRVEU",
  y: "x_FEzRu9m36HLN_tue659LNpXW6pCyStikYjKIWI5a0",
};

function row(overrides: Record<string, unknown> = {}) {
  return {
    aice_id: "aice-1",
    issuer: "https://aice.test",
    kid: "key-1",
    public_key: sampleKey,
    expires_at: null,
    ...overrides,
  };
}

beforeAll(() => {
  vi.useFakeTimers();
});

afterAll(() => {
  vi.useRealTimers();
});

afterEach(() => {
  vi.clearAllMocks();
  invalidateTrustRegistryCache();
});

describe("trust registry", () => {
  it("returns entry for a matching key", async () => {
    mockQuery.mockResolvedValueOnce([row()]);

    const result = await lookupTrustRegistryKey(
      fakePool,
      "aice-1",
      "https://aice.test",
      "key-1",
    );
    expect(result.entry).not.toBeNull();
    expect(result.rejection).toBeNull();
    expect(result.entry?.aiceId).toBe("aice-1");
    expect(result.entry?.issuer).toBe("https://aice.test");
    expect(result.entry?.kid).toBe("key-1");
    expect(result.entry?.publicKey).toEqual(sampleKey);
    expect(result.entry?.expiresAtMs).toBeNull();
  });

  it("returns unknown rejection for missing kid", async () => {
    mockQuery.mockResolvedValueOnce([row()]);

    const result = await lookupTrustRegistryKey(
      fakePool,
      "aice-1",
      "https://aice.test",
      "unknown-kid",
    );
    expect(result.entry).toBeNull();
    expect(result.rejection?.reason).toBe("unknown");
  });

  it("supports multiple keys per issuer (key rotation)", async () => {
    const key2: JsonWebKey = { ...sampleKey, x: "different" };
    mockQuery.mockResolvedValueOnce([
      row(),
      row({ kid: "key-2", public_key: key2 }),
    ]);

    const r1 = await lookupTrustRegistryKey(
      fakePool,
      "aice-1",
      "https://aice.test",
      "key-1",
    );
    const r2 = await lookupTrustRegistryKey(
      fakePool,
      "aice-1",
      "https://aice.test",
      "key-2",
    );
    expect(r1.entry?.publicKey).toEqual(sampleKey);
    expect(r2.entry?.publicKey).toEqual(key2);
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it("caches results for 60 seconds", async () => {
    mockQuery.mockResolvedValue([row()]);

    await lookupTrustRegistryKey(
      fakePool,
      "aice-1",
      "https://aice.test",
      "key-1",
    );
    await lookupTrustRegistryKey(
      fakePool,
      "aice-1",
      "https://aice.test",
      "key-1",
    );
    expect(mockQuery).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(61_000);
    await lookupTrustRegistryKey(
      fakePool,
      "aice-1",
      "https://aice.test",
      "key-1",
    );
    expect(mockQuery).toHaveBeenCalledTimes(2);
  });

  it("invalidateCache forces a fresh load", async () => {
    mockQuery.mockResolvedValue([row()]);

    await lookupTrustRegistryKey(
      fakePool,
      "aice-1",
      "https://aice.test",
      "key-1",
    );
    invalidateTrustRegistryCache();
    await lookupTrustRegistryKey(
      fakePool,
      "aice-1",
      "https://aice.test",
      "key-1",
    );
    expect(mockQuery).toHaveBeenCalledTimes(2);
  });

  it("distinguishes keys across different aice_ids", async () => {
    mockQuery.mockResolvedValueOnce([
      row(),
      row({ aice_id: "aice-2", public_key: { ...sampleKey, x: "other" } }),
    ]);

    const r1 = await lookupTrustRegistryKey(
      fakePool,
      "aice-1",
      "https://aice.test",
      "key-1",
    );
    const r2 = await lookupTrustRegistryKey(
      fakePool,
      "aice-2",
      "https://aice.test",
      "key-1",
    );
    expect(r1.entry?.aiceId).toBe("aice-1");
    expect(r2.entry?.aiceId).toBe("aice-2");
    expect(r1.entry?.publicKey).not.toEqual(r2.entry?.publicKey);
  });

  it("propagates expires_at into the cached entry", async () => {
    const future = new Date(Date.now() + 30_000);
    mockQuery.mockResolvedValueOnce([row({ expires_at: future })]);

    const r = await lookupTrustRegistryKey(
      fakePool,
      "aice-1",
      "https://aice.test",
      "key-1",
    );
    expect(r.entry?.expiresAtMs).toBe(future.getTime());
  });

  it("rejects with `expired` when expires_at is in the past", async () => {
    const past = new Date(Date.now() - 1000);
    mockQuery.mockResolvedValueOnce([row({ expires_at: past })]);

    const r = await lookupTrustRegistryKey(
      fakePool,
      "aice-1",
      "https://aice.test",
      "key-1",
    );
    expect(r.entry).toBeNull();
    expect(r.rejection?.reason).toBe("expired");
    if (r.rejection?.reason === "expired") {
      expect(r.rejection.expiresAtMs).toBe(past.getTime());
    }
  });

  it("hard-expires mid-cache-window on the very next verify", async () => {
    // Key expires 30s in the future. Cache TTL is 60s — without
    // per-call expiry the key would keep verifying for up to 30s past
    // expiry until the cache reload picked up the change.
    const expiresAt = new Date(Date.now() + 30_000);
    mockQuery.mockResolvedValue([row({ expires_at: expiresAt })]);

    const before = await lookupTrustRegistryKey(
      fakePool,
      "aice-1",
      "https://aice.test",
      "key-1",
    );
    expect(before.entry).not.toBeNull();
    expect(before.rejection).toBeNull();
    expect(mockQuery).toHaveBeenCalledTimes(1);

    // Advance past expires_at but well before the 60s cache TTL.
    vi.advanceTimersByTime(31_000);

    const after = await lookupTrustRegistryKey(
      fakePool,
      "aice-1",
      "https://aice.test",
      "key-1",
    );
    expect(after.entry).toBeNull();
    expect(after.rejection?.reason).toBe("expired");
    // No second DB load — the rejection came from per-call evaluation,
    // not a cache reload.
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });
});
