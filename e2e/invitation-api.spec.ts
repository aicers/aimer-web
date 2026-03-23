import { expect, test } from "@playwright/test";

// These tests exercise the POST /api/invitations HTTP layer without
// authentication.  They verify that the endpoint exists, enforces auth,
// and rejects malformed requests at the HTTP level.
//
// Full authenticated flows are covered by DB integration tests
// (src/lib/auth/__tests__/invitations.db.test.ts) which exercise the
// business logic directly.
//
// Email delivery is verified by the Mailpit integration test
// (src/lib/email/__tests__/invitation-delivery.integration.test.ts)
// which sends real SMTP and checks content via Mailpit API.

test.describe("POST /api/invitations", () => {
  test("returns 401 without auth cookie", async ({ request }) => {
    const res = await request.post("/api/invitations", {
      headers: { origin: "http://localhost:3000" },
      data: {
        customerId: "00000000-0000-0000-0000-000000000001",
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
      headers: { origin: "http://localhost:3000" },
      data: {
        customerId: "00000000-0000-0000-0000-000000000001",
        email: "test@example.com",
        role: "User",
      },
    });
    expect(res.status()).toBe(401);
  });

  test("returns 405 for GET method", async ({ request }) => {
    const res = await request.get("/api/invitations");
    // Next.js returns 405 for unimplemented methods on route handlers
    expect(res.status()).toBe(405);
  });
});
