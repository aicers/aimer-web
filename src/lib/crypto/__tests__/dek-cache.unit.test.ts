import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { DekCache } from "../dek-cache";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("DekCache", () => {
  it("returns undefined for uncached keys", () => {
    const cache = new DekCache();
    expect(cache.get("key", "wrapped")).toBeUndefined();
  });

  it("returns cached plaintext after set", () => {
    const cache = new DekCache();
    const plaintext = Buffer.from("secret-key-material");
    cache.set("key", "wrapped", plaintext);

    const result = cache.get("key", "wrapped");
    expect(result).toEqual(plaintext);
    expect(cache.size).toBe(1);
  });

  it("returns a clone — modifying result does not affect cache", () => {
    const cache = new DekCache();
    const plaintext = Buffer.from("secret-key-material");
    cache.set("key", "wrapped", plaintext);

    const result = cache.get("key", "wrapped");
    expect(result).toBeDefined();
    result?.fill(0);

    // Cache should still have the original value
    const result2 = cache.get("key", "wrapped");
    expect(result2).toEqual(Buffer.from("secret-key-material"));
  });

  it("stores a clone — zeroing the original does not affect cache", () => {
    const cache = new DekCache();
    const plaintext = Buffer.from("secret-key-material");
    cache.set("key", "wrapped", plaintext);

    plaintext.fill(0);

    const result = cache.get("key", "wrapped");
    expect(result).toEqual(Buffer.from("secret-key-material"));
  });

  it("evicts after TTL expires", () => {
    const cache = new DekCache(1000);
    cache.set("key", "wrapped", Buffer.from("secret"));

    expect(cache.get("key", "wrapped")).toBeDefined();

    vi.advanceTimersByTime(1001);

    expect(cache.get("key", "wrapped")).toBeUndefined();
    expect(cache.size).toBe(0);
  });

  it("invalidate removes and zeroes a specific entry", () => {
    const cache = new DekCache();
    cache.set("key-a", "wrapped-a", Buffer.from("secret-a"));
    cache.set("key-b", "wrapped-b", Buffer.from("secret-b"));

    cache.invalidate("key-a", "wrapped-a");

    expect(cache.get("key-a", "wrapped-a")).toBeUndefined();
    expect(cache.get("key-b", "wrapped-b")).toBeDefined();
    expect(cache.size).toBe(1);
  });

  it("clear zeroes and removes all entries", () => {
    const cache = new DekCache();
    cache.set("key-a", "wrapped-a", Buffer.from("secret-a"));
    cache.set("key-b", "wrapped-b", Buffer.from("secret-b"));

    cache.clear();

    expect(cache.size).toBe(0);
    expect(cache.get("key-a", "wrapped-a")).toBeUndefined();
    expect(cache.get("key-b", "wrapped-b")).toBeUndefined();
  });

  it("overwrites existing entry on re-set", () => {
    const cache = new DekCache();
    cache.set("key", "wrapped", Buffer.from("old-value"));
    cache.set("key", "wrapped", Buffer.from("new-value"));

    expect(cache.size).toBe(1);
    expect(cache.get("key", "wrapped")).toEqual(Buffer.from("new-value"));
  });
});
