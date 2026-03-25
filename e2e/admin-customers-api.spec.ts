import { expect, test } from "@playwright/test";

// These tests exercise the POST /api/admin/customers HTTP layer without
// authentication.  They verify that the endpoint exists, enforces admin
// auth, and rejects malformed requests at the HTTP level.
//
// Full authenticated flows are covered by DB integration tests
// (src/lib/auth/__tests__/customers.db.test.ts) which exercise the
// business logic directly.

const ENDPOINT = "/api/admin/customers";
const ORIGIN = "http://localhost:3000";

test.describe("POST /api/admin/customers", () => {
  // =========================================================================
  // Auth enforcement
  // =========================================================================

  test("returns 401 without auth cookie", async ({ request }) => {
    const res = await request.post(ENDPOINT, {
      headers: { origin: ORIGIN },
      data: {
        name: "Test Corp",
        externalKey: "test-001",
        managerAccountId: "00000000-0000-0000-0000-000000000001",
      },
    });
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

    const res = await context.request.post(ENDPOINT, {
      headers: { origin: ORIGIN },
      data: {
        name: "Test Corp",
        externalKey: "test-001",
        managerAccountId: "00000000-0000-0000-0000-000000000001",
      },
    });
    expect(res.status()).toBe(401);
  });

  test("returns 401 with general auth cookie (not admin)", async ({
    context,
  }) => {
    // A general-context cookie should not grant admin access
    await context.addCookies([
      {
        name: "at",
        value: "some-general-jwt-token",
        domain: "localhost",
        path: "/",
      },
    ]);

    const res = await context.request.post(ENDPOINT, {
      headers: { origin: ORIGIN },
      data: {
        name: "Test Corp",
        externalKey: "test-001",
        managerAccountId: "00000000-0000-0000-0000-000000000001",
      },
    });
    expect(res.status()).toBe(401);
  });

  // =========================================================================
  // Method enforcement
  // =========================================================================

  test("returns 405 for GET method", async ({ request }) => {
    const res = await request.get(ENDPOINT);
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
});
