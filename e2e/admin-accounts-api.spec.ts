import { expect, test } from "@playwright/test";

// These tests exercise the /api/admin/accounts HTTP layer without
// authentication.  They verify that the endpoints exist, enforce admin
// auth, and reject malformed requests at the HTTP level.

const LIST_ENDPOINT = "/api/admin/accounts";
const PATCH_ENDPOINT =
  "/api/admin/accounts/00000000-0000-0000-0000-000000000001";
const ORIGIN = "http://localhost:3000";

test.describe("GET /api/admin/accounts", () => {
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

  test("returns 405 for POST method", async ({ request }) => {
    const res = await request.post(LIST_ENDPOINT, {
      headers: { origin: ORIGIN },
      data: {},
    });
    expect(res.status()).toBe(405);
  });
});

test.describe("PATCH /api/admin/accounts/[accountId]", () => {
  test("returns 401 without auth cookie", async ({ request }) => {
    const res = await request.patch(PATCH_ENDPOINT, {
      headers: { origin: ORIGIN },
      data: { status: "suspended" },
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

    const res = await context.request.patch(PATCH_ENDPOINT, {
      headers: { origin: ORIGIN },
      data: { status: "suspended" },
    });
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

    const res = await context.request.patch(PATCH_ENDPOINT, {
      headers: { origin: ORIGIN },
      data: { status: "suspended" },
    });
    expect(res.status()).toBe(401);
  });

  test("returns 405 for GET method", async ({ request }) => {
    const res = await request.get(PATCH_ENDPOINT);
    expect(res.status()).toBe(405);
  });

  test("returns 405 for POST method", async ({ request }) => {
    const res = await request.post(PATCH_ENDPOINT, {
      headers: { origin: ORIGIN },
      data: { status: "suspended" },
    });
    expect(res.status()).toBe(405);
  });

  test("returns 405 for DELETE method", async ({ request }) => {
    const res = await request.delete(PATCH_ENDPOINT);
    expect(res.status()).toBe(405);
  });
});
