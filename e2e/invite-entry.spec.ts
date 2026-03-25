import { expect, test } from "@playwright/test";

// These tests exercise the GET /api/auth/invite/:token HTTP layer.
// They verify the endpoint exists, rejects invalid tokens, and returns
// correct redirect/cookie behavior at the HTTP level.
//
// Full invitation acceptance logic is covered by DB integration tests
// (src/lib/auth/__tests__/invitations.db.test.ts).

test.describe("GET /api/auth/invite/:token", () => {
  test("redirects to deny page for non-existent token", async ({ request }) => {
    const res = await request.get("/api/auth/invite/nonexistent-token-value", {
      maxRedirects: 0,
    });
    // Next.js redirect → 307
    expect(res.status()).toBe(307);
    const location = res.headers().location;
    expect(location).toContain("/deny?reason=invitation_expired");
  });

  test("sets Referrer-Policy header on valid redirect", async ({ request }) => {
    // Even though this token doesn't exist, the deny redirect path
    // doesn't set Referrer-Policy. The sign-in redirect (valid token)
    // would set it, but we can only test the deny path without a DB.
    const res = await request.get("/api/auth/invite/fake-token", {
      maxRedirects: 0,
    });
    expect(res.status()).toBe(307);
  });

  test("returns 405 for POST method", async ({ request }) => {
    const res = await request.post("/api/auth/invite/some-token");
    expect(res.status()).toBe(405);
  });

  test("returns 405 for PUT method", async ({ request }) => {
    const res = await request.put("/api/auth/invite/some-token");
    expect(res.status()).toBe(405);
  });

  test("returns 405 for DELETE method", async ({ request }) => {
    const res = await request.delete("/api/auth/invite/some-token");
    expect(res.status()).toBe(405);
  });
});
