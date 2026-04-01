import { expect, test } from "@playwright/test";

// E2E tests for GET /api/admin/detection/alerts HTTP layer without
// authentication.  Verifies the endpoint exists, enforces admin auth,
// rejects invalid methods, and validates query parameters.

const ENDPOINT = "/api/admin/detection/alerts";
const ORIGIN = "http://localhost:3000";

test.describe("GET /api/admin/detection/alerts", () => {
  // =========================================================================
  // Auth enforcement
  // =========================================================================

  test("returns 401 without auth cookie", async ({ request }) => {
    const res = await request.get(ENDPOINT);
    expect(res.status()).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("Unauthorized");
  });

  test("returns 401 with invalid admin auth cookie", async ({ context }) => {
    await context.addCookies([
      {
        name: "at_admin",
        value: "invalid-jwt-token",
        domain: "localhost",
        path: "/",
      },
    ]);

    const res = await context.request.get(ENDPOINT);
    expect(res.status()).toBe(401);
  });

  test("returns 401 with general auth cookie (not admin)", async ({
    context,
  }) => {
    await context.addCookies([
      {
        name: "at",
        value: "some-general-jwt-token",
        domain: "localhost",
        path: "/",
      },
    ]);

    const res = await context.request.get(ENDPOINT);
    expect(res.status()).toBe(401);
  });

  // =========================================================================
  // Method enforcement
  // =========================================================================

  test("returns 405 for POST method", async ({ request }) => {
    const res = await request.post(ENDPOINT, {
      headers: { origin: ORIGIN },
      data: {},
    });
    expect(res.status()).toBe(405);
  });

  test("returns 405 for PUT method", async ({ request }) => {
    const res = await request.put(ENDPOINT, {
      headers: { origin: ORIGIN },
      data: {},
    });
    expect(res.status()).toBe(405);
  });

  test("returns 405 for DELETE method", async ({ request }) => {
    const res = await request.delete(ENDPOINT);
    expect(res.status()).toBe(405);
  });

  // =========================================================================
  // Query parameter validation (unauthenticated — 401 takes precedence,
  // but ensures endpoint is reachable and doesn't crash)
  // =========================================================================

  test("does not crash with invalid query params (returns 401)", async ({
    request,
  }) => {
    const res = await request.get(
      `${ENDPOINT}?cursor=bad&limit=abc&severity=x`,
    );
    expect(res.status()).toBe(401);
  });
});
