import { expect, test } from "@playwright/test";

test.describe("bridge API endpoint", () => {
  const BASE_URL = "http://localhost:3000";

  test("POST /api/auth/bridge returns 400 without context_token", async ({
    request,
  }) => {
    const res = await request.post(`${BASE_URL}/api/auth/bridge`, {
      multipart: {},
    });
    // Missing context_token → 400
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("context_token");
  });

  test("POST /api/auth/bridge returns 403 for invalid context token", async ({
    request,
  }) => {
    const res = await request.post(`${BASE_URL}/api/auth/bridge`, {
      multipart: {
        context_token: "invalid.jwt.token",
      },
    });
    expect(res.status()).toBe(403);
    const body = await res.json();
    expect(body.error).toContain("Invalid context token");
  });

  test("GET /api/auth/bridge returns 405", async ({ request }) => {
    const res = await request.get(`${BASE_URL}/api/auth/bridge`);
    expect(res.status()).toBe(405);
  });
});
