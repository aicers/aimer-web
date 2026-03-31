import { expect, test } from "@playwright/test";

// E2E tests for GET /api/admin/audit-logs HTTP layer without
// authentication.  Verifies the endpoint exists, enforces admin auth,
// rejects invalid methods, and validates query parameters.
//
// Authenticated flows are covered by authorization-api.spec.ts and
// the unit tests in src/app/api/admin/audit-logs/__tests__/.

const ENDPOINT = "/api/admin/audit-logs";
const ORIGIN = "http://localhost:3000";

test.describe("GET /api/admin/audit-logs", () => {
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

  test("returns 405 for PATCH method", async ({ request }) => {
    const res = await request.patch(ENDPOINT, {
      headers: { origin: ORIGIN },
      data: {},
    });
    expect(res.status()).toBe(405);
  });

  // =========================================================================
  // Query parameter validation (unauthenticated — 401 takes precedence,
  // but these ensure the endpoint is reachable and doesn't crash)
  // =========================================================================

  test("does not crash with invalid query params (returns 401)", async ({
    request,
  }) => {
    const res = await request.get(
      `${ENDPOINT}?cursor=bad&limit=abc&auth_context=x`,
    );
    // 401 takes precedence over 400 since there's no auth
    expect(res.status()).toBe(401);
  });
});
