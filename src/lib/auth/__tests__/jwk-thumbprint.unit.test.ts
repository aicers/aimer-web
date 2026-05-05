import { calculateJwkThumbprint, exportJWK, generateKeyPair } from "jose";
import { describe, expect, it } from "vitest";
import {
  computeJwkThumbprint,
  formatThumbprintHex,
  InvalidJwkError,
} from "../jwk-thumbprint";

describe("formatThumbprintHex", () => {
  it("renders 4-byte (8 hex char) blocks separated by ':' for a known SHA-256", () => {
    // SHA-256("") base64url-encoded:
    //   e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
    const base64url = "47DEQpj8HBSa-_TImW-5JCeuQeRkm5NMpJWZG3hSuFU";
    const hex = formatThumbprintHex(base64url);

    expect(hex).toBe(
      "e3b0c442:98fc1c14:9afbf4c8:996fb924:27ae41e4:649b934c:a495991b:7852b855",
    );
    // Eight 8-char groups separated by 7 colons → 71 chars total.
    expect(hex.length).toBe(71);
    expect(hex.split(":")).toHaveLength(8);
    for (const group of hex.split(":")) {
      expect(group).toMatch(/^[0-9a-f]{8}$/);
    }
  });

  it("throws InvalidJwkError when input is not a 32-byte digest", () => {
    expect(() => formatThumbprintHex("AAAA")).toThrow(InvalidJwkError);
  });
});

describe("computeJwkThumbprint", () => {
  it("matches jose.calculateJwkThumbprint for an EC P-256 key", async () => {
    const { publicKey } = await generateKeyPair("ES256", { extractable: true });
    const jwk = await exportJWK(publicKey as CryptoKey);
    const expected = await calculateJwkThumbprint(jwk, "sha256");

    const result = await computeJwkThumbprint(jwk);

    expect(result.base64url).toBe(expected);
    // base64url with no padding is 43 chars for a SHA-256 digest.
    expect(result.base64url).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(result.hex.split(":")).toHaveLength(8);
  });

  it("matches jose.calculateJwkThumbprint for an RSA key", async () => {
    const { publicKey } = await generateKeyPair("RS256", {
      extractable: true,
      modulusLength: 2048,
    });
    const jwk = await exportJWK(publicKey as CryptoKey);
    const expected = await calculateJwkThumbprint(jwk, "sha256");

    const result = await computeJwkThumbprint(jwk);

    expect(result.base64url).toBe(expected);
  });

  it("matches jose.calculateJwkThumbprint for an OKP (Ed25519) key", async () => {
    const { publicKey } = await generateKeyPair("EdDSA", {
      extractable: true,
      crv: "Ed25519",
    });
    const jwk = await exportJWK(publicKey as CryptoKey);
    const expected = await calculateJwkThumbprint(jwk, "sha256");

    const result = await computeJwkThumbprint(jwk);

    expect(result.base64url).toBe(expected);
  });

  it("throws InvalidJwkError for non-object input", async () => {
    await expect(computeJwkThumbprint("not-an-object")).rejects.toBeInstanceOf(
      InvalidJwkError,
    );
    await expect(computeJwkThumbprint(null)).rejects.toBeInstanceOf(
      InvalidJwkError,
    );
    await expect(computeJwkThumbprint([1, 2, 3])).rejects.toBeInstanceOf(
      InvalidJwkError,
    );
  });

  it("throws InvalidJwkError for unsupported kty", async () => {
    await expect(
      computeJwkThumbprint({ kty: "BOGUS", x: "abc" }),
    ).rejects.toBeInstanceOf(InvalidJwkError);
  });

  it("throws InvalidJwkError when required JWK params are missing", async () => {
    await expect(
      computeJwkThumbprint({ kty: "EC", crv: "P-256" }),
    ).rejects.toBeInstanceOf(InvalidJwkError);
  });
});
