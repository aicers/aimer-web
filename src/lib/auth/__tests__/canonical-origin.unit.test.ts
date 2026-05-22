import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { canonicalOrigin } from "../canonical-origin";

describe("canonicalOrigin", () => {
  beforeEach(() => {
    vi.stubEnv("EXPECTED_ORIGIN", "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns EXPECTED_ORIGIN env when set", () => {
    vi.stubEnv("EXPECTED_ORIGIN", "https://aimer-web.example.com");
    const req = new NextRequest("http://0.0.0.0:3000/api/auth/sign-in");
    expect(canonicalOrigin(req)).toBe("https://aimer-web.example.com");
  });

  it("returns EXPECTED_ORIGIN env even without a request argument", () => {
    vi.stubEnv("EXPECTED_ORIGIN", "https://aimer-web.example.com");
    expect(canonicalOrigin()).toBe("https://aimer-web.example.com");
  });

  it("throws in production when EXPECTED_ORIGIN is unset", () => {
    vi.stubEnv("NODE_ENV", "production");
    const req = new NextRequest("http://0.0.0.0:3000/api/auth/sign-in");
    expect(() => canonicalOrigin(req)).toThrow(
      /EXPECTED_ORIGIN is required in production/,
    );
  });

  it("falls back to request.nextUrl.origin in non-production", () => {
    vi.stubEnv("NODE_ENV", "development");
    const req = new NextRequest("http://localhost:3000/api/auth/sign-in");
    expect(canonicalOrigin(req)).toBe("http://localhost:3000");
  });

  it("throws in non-production when no request and no env", () => {
    vi.stubEnv("NODE_ENV", "development");
    expect(() => canonicalOrigin()).toThrow(
      /canonicalOrigin called without request and without EXPECTED_ORIGIN/,
    );
  });
});
