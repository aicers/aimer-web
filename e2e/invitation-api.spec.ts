import { expect, test } from "@playwright/test";

// These tests exercise the /api/invitations HTTP layer without
// authentication.  They verify that the endpoints exist, enforce auth,
// and reject malformed requests at the HTTP level.
//
// Full authenticated flows (permission checks, listing, revocation,
// concurrency) are covered by DB integration tests
// (src/lib/auth/__tests__/invitation-management.db.test.ts and
//  src/lib/auth/__tests__/invitations.db.test.ts).
//
// Email delivery is verified by the Mailpit integration test
// (src/lib/email/__tests__/invitation-delivery.integration.test.ts)
// which sends real SMTP and checks content via Mailpit API.

const ORIGIN = "http://localhost:3000";
const DUMMY_UUID = "00000000-0000-0000-0000-000000000001";

// ==========================================================================
// POST /api/invitations
// ==========================================================================

test.describe("POST /api/invitations", () => {
  test("returns 401 without auth cookie", async ({ request }) => {
    const res = await request.post("/api/invitations", {
      headers: { origin: ORIGIN },
      data: {
        customerId: DUMMY_UUID,
        email: "test@example.com",
        role: "User",
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

    const res = await context.request.post("/api/invitations", {
      headers: { origin: ORIGIN },
      data: {
        customerId: DUMMY_UUID,
        email: "test@example.com",
        role: "User",
      },
    });
    expect(res.status()).toBe(401);
  });
});

// ==========================================================================
// GET /api/invitations
// ==========================================================================

test.describe("GET /api/invitations", () => {
  test("returns 401 without auth cookie", async ({ request }) => {
    const res = await request.get(`/api/invitations?customer_id=${DUMMY_UUID}`);
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
      `/api/invitations?customer_id=${DUMMY_UUID}`,
    );
    expect(res.status()).toBe(401);
  });

  test("returns 405 for PUT method", async ({ request }) => {
    const res = await request.put("/api/invitations", {
      headers: { origin: ORIGIN },
      data: {},
    });
    expect(res.status()).toBe(405);
  });
});

// ==========================================================================
// DELETE /api/invitations/:id
// ==========================================================================

test.describe("DELETE /api/invitations/:id", () => {
  test("returns 401 without auth cookie", async ({ request }) => {
    const res = await request.delete(`/api/invitations/${DUMMY_UUID}`);
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

    const res = await context.request.delete(`/api/invitations/${DUMMY_UUID}`, {
      headers: { origin: ORIGIN },
    });
    expect(res.status()).toBe(401);
  });

  test("returns 405 for GET method", async ({ request }) => {
    const res = await request.get(`/api/invitations/${DUMMY_UUID}`);
    expect(res.status()).toBe(405);
  });
});
