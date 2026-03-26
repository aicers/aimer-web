import { expect, test } from "@playwright/test";

// These tests exercise the roles API HTTP layer without authentication.
// They verify that the endpoint exists, enforces auth, and rejects
// unsupported methods.

// =========================================================================
// GET /api/roles
// =========================================================================

test.describe("GET /api/roles", () => {
  test("returns 401 without auth cookie", async ({ request }) => {
    const res = await request.get("/api/roles");
    expect(res.status()).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("Unauthorized");
  });

  test("returns 401 with invalid auth cookie", async ({ context }) => {
    await context.addCookies([
      {
        name: "at",
        value: "invalid-jwt-token",
        domain: "localhost",
        path: "/",
      },
    ]);

    const res = await context.request.get("/api/roles");
    expect(res.status()).toBe(401);
  });

  test("returns 405 for POST method", async ({ request }) => {
    const res = await request.post("/api/roles", {
      headers: { origin: "http://localhost:3000" },
      data: {},
    });
    expect(res.status()).toBe(405);
  });

  test("returns 405 for DELETE method", async ({ request }) => {
    const res = await request.delete("/api/roles");
    expect(res.status()).toBe(405);
  });

  test("returns 405 for PUT method", async ({ request }) => {
    const res = await request.put("/api/roles", {
      headers: { origin: "http://localhost:3000" },
      data: {},
    });
    expect(res.status()).toBe(405);
  });

  test("returns 405 for PATCH method", async ({ request }) => {
    const res = await request.patch("/api/roles", {
      headers: { origin: "http://localhost:3000" },
      data: {},
    });
    expect(res.status()).toBe(405);
  });
});
