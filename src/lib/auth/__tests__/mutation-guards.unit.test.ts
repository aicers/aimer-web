import { NextRequest } from "next/server";
import { describe, expect, it, vi } from "vitest";
import { verifyCsrf, verifyOrigin } from "../guards";

// Mock server-only audit module so importing guards doesn't throw
vi.mock("@/lib/audit", () => ({
  auditLog: vi.fn(),
}));

// Mock the csrf module to avoid needing CSRF_SECRET env var
vi.mock("../csrf", () => ({
  validateCsrf: vi.fn((params: { token: string }) => {
    return params.token === "valid-csrf-token";
  }),
}));

function makeRequest(
  url: string,
  headers: Record<string, string> = {},
): NextRequest {
  return new NextRequest(url, { headers });
}

describe("verifyOrigin", () => {
  it("returns null for matching origin", () => {
    const req = makeRequest("http://localhost:3000/api/invitations", {
      origin: "http://localhost:3000",
    });
    expect(verifyOrigin(req)).toBeNull();
  });

  it("returns 403 for missing origin", () => {
    const req = makeRequest("http://localhost:3000/api/invitations");
    const resp = verifyOrigin(req);
    expect(resp).not.toBeNull();
    expect(resp?.status).toBe(403);
  });

  it("returns 403 for mismatched origin", () => {
    const req = makeRequest("http://localhost:3000/api/invitations", {
      origin: "http://evil.com",
    });
    const resp = verifyOrigin(req);
    expect(resp).not.toBeNull();
    expect(resp?.status).toBe(403);
  });

  it("returns 403 for malformed origin", () => {
    const req = makeRequest("http://localhost:3000/api/invitations", {
      origin: "not-a-url",
    });
    const resp = verifyOrigin(req);
    expect(resp).not.toBeNull();
    expect(resp?.status).toBe(403);
  });

  it("returns 403 for different port", () => {
    const req = makeRequest("http://localhost:3000/api/invitations", {
      origin: "http://localhost:4000",
    });
    const resp = verifyOrigin(req);
    expect(resp).not.toBeNull();
    expect(resp?.status).toBe(403);
  });

  it("returns 403 for different protocol", () => {
    const req = makeRequest("https://localhost:3000/api/invitations", {
      origin: "http://localhost:3000",
    });
    const resp = verifyOrigin(req);
    expect(resp).not.toBeNull();
    expect(resp?.status).toBe(403);
  });
});

describe("verifyCsrf", () => {
  const baseUrl = "http://localhost:3000/api/invitations";
  const csrfParams = { ctx: "general" as const, sid: "test-sid", iat: 123 };

  it("returns null for valid CSRF token", () => {
    const req = makeRequest(baseUrl, {
      origin: baseUrl,
      "x-csrf-token": "valid-csrf-token",
    });
    expect(verifyCsrf(req, csrfParams)).toBeNull();
  });

  it("returns 403 for missing CSRF token", () => {
    const req = makeRequest(baseUrl, { origin: baseUrl });
    const resp = verifyCsrf(req, csrfParams);
    expect(resp).not.toBeNull();
    expect(resp?.status).toBe(403);
  });

  it("returns 403 for invalid CSRF token", () => {
    const req = makeRequest(baseUrl, {
      origin: baseUrl,
      "x-csrf-token": "bad-token",
    });
    const resp = verifyCsrf(req, csrfParams);
    expect(resp).not.toBeNull();
    expect(resp?.status).toBe(403);
  });

  it("reads x-csrf-token-admin header for admin context", () => {
    const req = makeRequest(baseUrl, {
      origin: baseUrl,
      "x-csrf-token-admin": "valid-csrf-token",
    });
    const adminParams = { ctx: "admin" as const, sid: "test-sid", iat: 123 };
    expect(verifyCsrf(req, adminParams)).toBeNull();
  });

  it("returns 403 when admin token is in general header", () => {
    const req = makeRequest(baseUrl, {
      origin: baseUrl,
      "x-csrf-token": "valid-csrf-token",
    });
    const adminParams = { ctx: "admin" as const, sid: "test-sid", iat: 123 };
    const resp = verifyCsrf(req, adminParams);
    expect(resp).not.toBeNull();
    expect(resp?.status).toBe(403);
  });
});
