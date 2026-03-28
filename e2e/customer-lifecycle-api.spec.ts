import { expect, test } from "@playwright/test";

// ---------------------------------------------------------------------------
// Unauthenticated boundary tests for customer lifecycle API.
// Verify that endpoints enforce auth, validate input, and reject
// unsupported methods.
//
// Full authenticated provisioning/deletion flows are covered by DB
// integration tests:
// - src/lib/db/__tests__/provision-customer.db.test.ts
// - src/lib/auth/__tests__/delete-customer.db.test.ts
// ---------------------------------------------------------------------------

const DUMMY_UUID = "00000000-0000-0000-0000-000000000001";
const ORIGIN = "http://localhost:3000";

// =========================================================================
// POST /api/admin/customers (create + provision)
// =========================================================================

test.describe("POST /api/admin/customers", () => {
  test("returns 401 without admin auth cookie", async ({ request }) => {
    const res = await request.post("/api/admin/customers", {
      headers: { origin: ORIGIN, "content-type": "application/json" },
      data: {
        name: "Test",
        externalKey: "test-key",
        managerAccountId: DUMMY_UUID,
      },
    });
    expect(res.status()).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("Unauthorized");
  });

  test("returns 401 with invalid admin cookie", async ({ context }) => {
    await context.addCookies([
      {
        name: "at_admin",
        value: "invalid-jwt-token",
        domain: "localhost",
        path: "/",
      },
    ]);

    const res = await context.request.post("/api/admin/customers", {
      headers: { origin: ORIGIN, "content-type": "application/json" },
      data: {
        name: "Test",
        externalKey: "test-key",
        managerAccountId: DUMMY_UUID,
      },
    });
    expect(res.status()).toBe(401);
  });

  test("returns 401 with general auth cookie (requires admin)", async ({
    context,
  }) => {
    await context.addCookies([
      {
        name: "at",
        value: "some-general-jwt",
        domain: "localhost",
        path: "/",
      },
    ]);

    const res = await context.request.post("/api/admin/customers", {
      headers: { origin: ORIGIN, "content-type": "application/json" },
      data: { name: "Test", externalKey: "key", managerAccountId: DUMMY_UUID },
    });
    expect(res.status()).toBe(401);
  });

  test("returns 405 for GET method", async ({ request }) => {
    const res = await request.get("/api/admin/customers");
    expect(res.status()).toBe(405);
  });
});

// =========================================================================
// DELETE /api/admin/customers/:customerId
// =========================================================================

test.describe("DELETE /api/admin/customers/:customerId", () => {
  test("returns 401 without admin auth cookie", async ({ request }) => {
    const res = await request.delete(`/api/admin/customers/${DUMMY_UUID}`, {
      headers: { origin: ORIGIN },
    });
    expect(res.status()).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("Unauthorized");
  });

  test("returns 401 with invalid admin cookie", async ({ context }) => {
    await context.addCookies([
      {
        name: "at_admin",
        value: "invalid-jwt-token",
        domain: "localhost",
        path: "/",
      },
    ]);

    const res = await context.request.delete(
      `/api/admin/customers/${DUMMY_UUID}`,
      { headers: { origin: ORIGIN } },
    );
    expect(res.status()).toBe(401);
  });

  test("returns 401 with general auth cookie (requires admin)", async ({
    context,
  }) => {
    await context.addCookies([
      {
        name: "at",
        value: "some-general-jwt",
        domain: "localhost",
        path: "/",
      },
    ]);

    const res = await context.request.delete(
      `/api/admin/customers/${DUMMY_UUID}`,
      { headers: { origin: ORIGIN } },
    );
    expect(res.status()).toBe(401);
  });

  test("returns 405 for GET method on /:customerId route", async ({
    request,
  }) => {
    const res = await request.get(`/api/admin/customers/${DUMMY_UUID}`);
    expect(res.status()).toBe(405);
  });

  test("returns 405 for POST method on /:customerId route", async ({
    request,
  }) => {
    const res = await request.post(`/api/admin/customers/${DUMMY_UUID}`, {
      headers: { origin: ORIGIN },
    });
    expect(res.status()).toBe(405);
  });

  test("returns 405 for PATCH method on /:customerId route", async ({
    request,
  }) => {
    const res = await request.patch(`/api/admin/customers/${DUMMY_UUID}`, {
      headers: { origin: ORIGIN },
    });
    expect(res.status()).toBe(405);
  });
});
