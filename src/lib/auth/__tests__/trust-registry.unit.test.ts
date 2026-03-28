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
    mockQuery.mockResolvedValueOnce([
      {
        aice_id: "aice-1",
        issuer: "https://aice.test",
        kid: "key-1",
        public_key: sampleKey,
      },
    ]);

    const entry = await lookupTrustRegistryKey(
      fakePool,
      "aice-1",
      "https://aice.test",
      "key-1",
    );
    expect(entry).not.toBeNull();
    expect(entry?.aiceId).toBe("aice-1");
    expect(entry?.issuer).toBe("https://aice.test");
    expect(entry?.kid).toBe("key-1");
    expect(entry?.publicKey).toEqual(sampleKey);
  });

  it("returns null for unknown key", async () => {
    mockQuery.mockResolvedValueOnce([
      {
        aice_id: "aice-1",
        issuer: "https://aice.test",
        kid: "key-1",
        public_key: sampleKey,
      },
    ]);

    const entry = await lookupTrustRegistryKey(
      fakePool,
      "aice-1",
      "https://aice.test",
      "unknown-kid",
    );
    expect(entry).toBeNull();
  });

  it("supports multiple keys per issuer (key rotation)", async () => {
    const key2: JsonWebKey = { ...sampleKey, x: "different" };
    mockQuery.mockResolvedValueOnce([
      {
        aice_id: "aice-1",
        issuer: "https://aice.test",
        kid: "key-1",
        public_key: sampleKey,
      },
      {
        aice_id: "aice-1",
        issuer: "https://aice.test",
        kid: "key-2",
        public_key: key2,
      },
    ]);

    const entry1 = await lookupTrustRegistryKey(
      fakePool,
      "aice-1",
      "https://aice.test",
      "key-1",
    );
    const entry2 = await lookupTrustRegistryKey(
      fakePool,
      "aice-1",
      "https://aice.test",
      "key-2",
    );
    expect(entry1?.publicKey).toEqual(sampleKey);
    expect(entry2?.publicKey).toEqual(key2);
    // Only one DB call (cache hit for second lookup)
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it("caches results for 60 seconds", async () => {
    mockQuery.mockResolvedValue([
      {
        aice_id: "aice-1",
        issuer: "https://aice.test",
        kid: "key-1",
        public_key: sampleKey,
      },
    ]);

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

    // Advance past TTL
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
    mockQuery.mockResolvedValue([
      {
        aice_id: "aice-1",
        issuer: "https://aice.test",
        kid: "key-1",
        public_key: sampleKey,
      },
    ]);

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
      {
        aice_id: "aice-1",
        issuer: "https://aice.test",
        kid: "key-1",
        public_key: sampleKey,
      },
      {
        aice_id: "aice-2",
        issuer: "https://aice.test",
        kid: "key-1",
        public_key: { ...sampleKey, x: "other" },
      },
    ]);

    const e1 = await lookupTrustRegistryKey(
      fakePool,
      "aice-1",
      "https://aice.test",
      "key-1",
    );
    const e2 = await lookupTrustRegistryKey(
      fakePool,
      "aice-2",
      "https://aice.test",
      "key-1",
    );
    expect(e1?.aiceId).toBe("aice-1");
    expect(e2?.aiceId).toBe("aice-2");
    expect(e1?.publicKey).not.toEqual(e2?.publicKey);
  });
});
