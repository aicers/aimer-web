import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

// Mock the transit module
const mockGenerateDataKey = vi.fn();
const mockDecryptDataKey = vi.fn();

vi.mock("../transit", () => ({
  getTransitConfig: () => ({ addr: "http://localhost:8200", token: "test" }),
  generateDataKey: (...args: unknown[]) => mockGenerateDataKey(...args),
  decryptDataKey: (...args: unknown[]) => mockDecryptDataKey(...args),
}));

import { decryptPayload, encryptPayload } from "../envelope";

afterEach(() => {
  vi.clearAllMocks();
});

function setupMockKeys() {
  // Use a real 256-bit key for AES-256-GCM
  const realKey = randomBytes(32);
  const wrappedDek = "vault:v1:mockedwrappedkey";

  mockGenerateDataKey.mockResolvedValue({
    plaintext: Buffer.from(realKey),
    wrappedDek,
  });

  // For decryption, return the same key
  mockDecryptDataKey.mockResolvedValue(Buffer.from(realKey));

  return { realKey, wrappedDek };
}

describe("encryptPayload", () => {
  it("encrypts plaintext and returns ciphertext + wrappedDek", async () => {
    const { wrappedDek } = setupMockKeys();
    const plaintext = Buffer.from("hello world detection events");

    const result = await encryptPayload(plaintext);

    expect(result.wrappedDek).toBe(wrappedDek);
    expect(result.ciphertext).toBeInstanceOf(Buffer);
    // IV (12) + at least 1 byte of ciphertext + auth tag (16)
    expect(result.ciphertext.length).toBeGreaterThanOrEqual(12 + 1 + 16);
    // Ciphertext should differ from plaintext
    expect(result.ciphertext.toString("hex")).not.toBe(
      plaintext.toString("hex"),
    );

    expect(mockGenerateDataKey).toHaveBeenCalledWith(
      { addr: "http://localhost:8200", token: "test" },
      "staging-events",
    );
  });

  it("uses custom key name when provided", async () => {
    setupMockKeys();
    const plaintext = Buffer.from("data");

    await encryptPayload(plaintext, "custom-key");

    expect(mockGenerateDataKey).toHaveBeenCalledWith(
      expect.anything(),
      "custom-key",
    );
  });
});

describe("decryptPayload", () => {
  it("round-trips: encrypt then decrypt returns original plaintext", async () => {
    setupMockKeys();
    const original = Buffer.from(
      "binary detection event payload with special chars: \x00\xff\xfe",
    );

    const encrypted = await encryptPayload(original);
    const decrypted = await decryptPayload(
      encrypted.ciphertext,
      encrypted.wrappedDek,
    );

    expect(decrypted).toEqual(original);
  });

  it("round-trips large payloads", async () => {
    setupMockKeys();
    const original = randomBytes(1024 * 1024); // 1 MB

    const encrypted = await encryptPayload(original);
    const decrypted = await decryptPayload(
      encrypted.ciphertext,
      encrypted.wrappedDek,
    );

    expect(decrypted).toEqual(original);
  });

  it("throws on ciphertext too short", async () => {
    setupMockKeys();

    await expect(
      decryptPayload(Buffer.from("short"), "vault:v1:key"),
    ).rejects.toThrow("Ciphertext too short");
  });

  it("throws on tampered ciphertext", async () => {
    setupMockKeys();
    const original = Buffer.from("sensitive data");

    const encrypted = await encryptPayload(original);
    // Tamper with a byte in the middle of the ciphertext
    const tampered = Buffer.from(encrypted.ciphertext);
    tampered[14] ^= 0xff;

    await expect(
      decryptPayload(tampered, encrypted.wrappedDek),
    ).rejects.toThrow();
  });

  it("encrypts empty buffer", async () => {
    setupMockKeys();
    const original = Buffer.alloc(0);

    const encrypted = await encryptPayload(original);
    const decrypted = await decryptPayload(
      encrypted.ciphertext,
      encrypted.wrappedDek,
    );

    expect(decrypted).toEqual(original);
  });
});

describe("ciphertext format", () => {
  it("starts with 12-byte IV and ends with 16-byte auth tag", async () => {
    setupMockKeys();
    const plaintext = Buffer.from("test data");
    const encrypted = await encryptPayload(plaintext);

    // Total length: 12 (IV) + plaintext.length (encrypted) + 16 (tag)
    expect(encrypted.ciphertext.length).toBe(12 + plaintext.length + 16);
  });
});
