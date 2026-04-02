import { expect, test } from "@playwright/test";

// These tests exercise the GET /api/admin/customers and
// POST /api/admin/customers/:id/retry-provision HTTP layers without
// authentication.  They verify that the endpoints exist, enforce admin
// auth, and reject wrong methods at the HTTP level.
//
// Verification items from Discussion #9:
// - 35-10: Customer creation requires manager_account_id (tested in
//   admin-customers-api.spec.ts and unit tests)
// - 44-2: Provision retry endpoint exists and enforces auth (tested here)

const LIST_ENDPOINT = "/api/admin/customers";
const RETRY_ENDPOINT =
  "/api/admin/customers/00000000-0000-0000-0000-000000000001/retry-provision";
const ORIGIN = "http://localhost:3000";

test.describe("GET /api/admin/customers", () => {
  test("returns 401 without auth cookie", async ({ request }) => {
    const res = await request.get(LIST_ENDPOINT);
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

    const res = await context.request.get(LIST_ENDPOINT);
    expect(res.status()).toBe(401);
  });

  test("returns 405 for PUT method", async ({ request }) => {
    const res = await request.put(LIST_ENDPOINT, {
      headers: { origin: ORIGIN },
      data: {},
    });
    expect(res.status()).toBe(405);
  });

  test("returns 405 for PATCH method", async ({ request }) => {
    const res = await request.patch(LIST_ENDPOINT, {
      headers: { origin: ORIGIN },
      data: {},
    });
    expect(res.status()).toBe(405);
  });
});

test.describe("POST /api/admin/customers/:id/retry-provision", () => {
  test("returns 401 without auth cookie", async ({ request }) => {
    const res = await request.post(RETRY_ENDPOINT, {
      headers: { origin: ORIGIN },
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

    const res = await context.request.post(RETRY_ENDPOINT, {
      headers: { origin: ORIGIN },
    });
    expect(res.status()).toBe(401);
  });

  test("returns 405 for GET method", async ({ request }) => {
    const res = await request.get(RETRY_ENDPOINT);
    expect(res.status()).toBe(405);
  });

  test("returns 405 for DELETE method", async ({ request }) => {
    const res = await request.delete(RETRY_ENDPOINT);
    expect(res.status()).toBe(405);
  });

  test("returns 405 for PUT method", async ({ request }) => {
    const res = await request.put(RETRY_ENDPOINT, {
      headers: { origin: ORIGIN },
      data: {},
    });
    expect(res.status()).toBe(405);
  });
});

test.describe("DELETE /api/admin/customers/:id", () => {
  const DELETE_ENDPOINT =
    "/api/admin/customers/00000000-0000-0000-0000-000000000001";

  test("returns 401 without auth cookie", async ({ request }) => {
    const res = await request.delete(DELETE_ENDPOINT, {
      headers: { origin: ORIGIN },
    });
    expect(res.status()).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("Unauthorized");
  });

  test("returns 405 for GET method", async ({ request }) => {
    const res = await request.get(DELETE_ENDPOINT);
    expect(res.status()).toBe(405);
  });
});
