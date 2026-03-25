import { expect, test } from "@playwright/test";

// These tests exercise the members API HTTP layer without authentication.
// They verify that the endpoints exist, enforce auth, reject malformed
// requests, and return correct method-not-allowed responses.
//
// Full authenticated flows (last Manager protection, role changes,
// concurrent safety) are covered by DB integration tests
// (src/lib/auth/__tests__/members.db.test.ts).

const ORIGIN = "http://localhost:3000";
const DUMMY_UUID = "00000000-0000-0000-0000-000000000001";

// =========================================================================
// GET /api/members
// =========================================================================

test.describe("GET /api/members", () => {
  test("returns 401 without auth cookie", async ({ request }) => {
    const res = await request.get(`/api/members?customer_id=${DUMMY_UUID}`);
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

    const res = await context.request.get(
      `/api/members?customer_id=${DUMMY_UUID}`,
    );
    expect(res.status()).toBe(401);
  });

  test("returns 405 for POST method", async ({ request }) => {
    const res = await request.post("/api/members", {
      headers: { origin: ORIGIN },
      data: {},
    });
    expect(res.status()).toBe(405);
  });

  test("returns 405 for PUT method", async ({ request }) => {
    const res = await request.put("/api/members", {
      headers: { origin: ORIGIN },
      data: {},
    });
    expect(res.status()).toBe(405);
  });

  test("returns 405 for DELETE method", async ({ request }) => {
    const res = await request.delete("/api/members");
    expect(res.status()).toBe(405);
  });
});

// =========================================================================
// DELETE /api/members/:accountId
// =========================================================================

test.describe("DELETE /api/members/:accountId", () => {
  test("returns 401 without auth cookie", async ({ request }) => {
    const res = await request.delete(
      `/api/members/${DUMMY_UUID}?customer_id=${DUMMY_UUID}`,
    );
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

    const res = await context.request.delete(
      `/api/members/${DUMMY_UUID}?customer_id=${DUMMY_UUID}`,
    );
    expect(res.status()).toBe(401);
  });

  test("returns 405 for GET method", async ({ request }) => {
    const res = await request.get(`/api/members/${DUMMY_UUID}`);
    expect(res.status()).toBe(405);
  });

  test("returns 405 for PUT method", async ({ request }) => {
    const res = await request.put(`/api/members/${DUMMY_UUID}`, {
      headers: { origin: ORIGIN },
      data: {},
    });
    expect(res.status()).toBe(405);
  });
});

// =========================================================================
// PATCH /api/members/:accountId
// =========================================================================

test.describe("PATCH /api/members/:accountId", () => {
  test("returns 401 without auth cookie", async ({ request }) => {
    const res = await request.patch(`/api/members/${DUMMY_UUID}`, {
      headers: { origin: ORIGIN },
      data: {
        customerId: DUMMY_UUID,
        roleId: 1,
      },
    });
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

    const res = await context.request.patch(`/api/members/${DUMMY_UUID}`, {
      headers: { origin: ORIGIN },
      data: {
        customerId: DUMMY_UUID,
        roleId: 1,
      },
    });
    expect(res.status()).toBe(401);
  });

  test("returns 405 for POST method on member endpoint", async ({
    request,
  }) => {
    const res = await request.post(`/api/members/${DUMMY_UUID}`, {
      headers: { origin: ORIGIN },
      data: {},
    });
    expect(res.status()).toBe(405);
  });
});
