import { expect, test } from "@playwright/test";

// E2E tests for POST /api/admin/detection/analyze cron endpoint.
// Verifies the shared secret protection.

const ENDPOINT = "/api/admin/detection/analyze";
const ORIGIN = "http://localhost:3000";

test.describe("POST /api/admin/detection/analyze", () => {
  test("returns 401 without authorization header", async ({ request }) => {
    const res = await request.post(ENDPOINT, {
      headers: { origin: ORIGIN },
    });
    expect(res.status()).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("Unauthorized");
  });

  test("returns 401 or 503 with wrong secret", async ({ request }) => {
    const res = await request.post(ENDPOINT, {
      headers: {
        origin: ORIGIN,
        authorization: "Bearer wrong-secret",
      },
    });
    // 401 when DETECTION_CRON_SECRET is set (secret mismatch),
    // 503 when it is not configured at all.
    expect([401, 503]).toContain(res.status());
  });

  test("returns 405 for GET method", async ({ request }) => {
    const res = await request.get(ENDPOINT);
    expect(res.status()).toBe(405);
  });
});
