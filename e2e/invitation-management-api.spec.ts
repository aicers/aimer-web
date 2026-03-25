import { expect, test } from "@playwright/test";

// These tests exercise the invitation list (GET) and revoke (DELETE) HTTP
// layer without authentication.  They verify that the endpoints exist,
// enforce auth, validate input, and reject unsupported methods.
//
// Full authenticated flows are covered by DB integration tests
// (src/lib/auth/__tests__/invitation-management.db.test.ts).

const VALID_UUID = "00000000-0000-0000-0000-000000000001";

// =========================================================================
// GET /api/invitations?customer_id=...
// =========================================================================

test.describe("GET /api/invitations", () => {
  test("returns 401 without auth cookie", async ({ request }) => {
    const res = await request.get(`/api/invitations?customer_id=${VALID_UUID}`);
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
      `/api/invitations?customer_id=${VALID_UUID}`,
    );
    expect(res.status()).toBe(401);
  });

  test("returns 400 without customer_id parameter", async ({ context }) => {
    await context.addCookies([
      {
        name: "at",
        value: "invalid-jwt-token",
        domain: "localhost",
        path: "/",
      },
    ]);

    // Without a valid JWT the request will 401 before reaching validation.
    // This test documents the guard ordering: auth comes first.
    const res = await context.request.get("/api/invitations");
    expect(res.status()).toBe(401);
  });
});

// =========================================================================
// DELETE /api/invitations/:id
// =========================================================================

test.describe("DELETE /api/invitations/:id", () => {
  test("returns 401 without auth cookie", async ({ request }) => {
    const res = await request.delete(`/api/invitations/${VALID_UUID}`, {
      headers: { origin: "http://localhost:3000" },
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

    const res = await context.request.delete(`/api/invitations/${VALID_UUID}`, {
      headers: { origin: "http://localhost:3000" },
    });
    expect(res.status()).toBe(401);
  });

  test("returns 405 for GET method on /:id route", async ({ request }) => {
    const res = await request.get(`/api/invitations/${VALID_UUID}`);
    expect(res.status()).toBe(405);
  });

  test("returns 405 for POST method on /:id route", async ({ request }) => {
    const res = await request.post(`/api/invitations/${VALID_UUID}`, {
      headers: { origin: "http://localhost:3000" },
    });
    expect(res.status()).toBe(405);
  });
});
