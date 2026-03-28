import { expect, test } from "@playwright/test";

// ---------------------------------------------------------------------------
// Unauthenticated boundary tests for staged events API.
// Verify that endpoints enforce auth and reject incorrect methods.
// ---------------------------------------------------------------------------

const DUMMY_UUID = "00000000-0000-0000-0000-000000000001";
const ORIGIN = "http://localhost:3000";

// =========================================================================
// GET /api/events/staged
// =========================================================================

test.describe("GET /api/events/staged", () => {
  test("returns 401 without auth cookie", async ({ request }) => {
    const res = await request.get("/api/events/staged");
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

    const res = await context.request.get("/api/events/staged");
    expect(res.status()).toBe(401);
  });

  test("returns 405 for POST method", async ({ request }) => {
    const res = await request.post("/api/events/staged", {
      headers: { origin: ORIGIN },
      data: {},
    });
    expect(res.status()).toBe(405);
  });
});

// =========================================================================
// GET /api/events/staged/:payloadId
// =========================================================================

test.describe("GET /api/events/staged/:payloadId", () => {
  test("returns 401 without auth cookie", async ({ request }) => {
    const res = await request.get(`/api/events/staged/${DUMMY_UUID}`);
    expect(res.status()).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("Unauthorized");
  });
});

// =========================================================================
// PATCH /api/events/staged/:payloadId/customers/:customerId
// =========================================================================

test.describe("PATCH /api/events/staged/:payloadId/customers/:customerId", () => {
  test("returns 401 without auth cookie", async ({ request }) => {
    const res = await request.patch(
      `/api/events/staged/${DUMMY_UUID}/customers/${DUMMY_UUID}`,
      {
        headers: { origin: ORIGIN, "content-type": "application/json" },
        data: { action: "approve" },
      },
    );
    expect(res.status()).toBe(401);
  });
});

// =========================================================================
// POST /api/events/ingest
// =========================================================================

test.describe("POST /api/events/ingest", () => {
  test("returns 401 without auth cookie", async ({ request }) => {
    const res = await request.post("/api/events/ingest", {
      headers: { origin: ORIGIN },
      multipart: {
        events_data: {
          name: "events.bin",
          mimeType: "application/octet-stream",
          buffer: Buffer.from("test"),
        },
        customer_id: DUMMY_UUID,
        aice_id: "aice-1",
        schema_version: "1.0",
        event_count: "5",
      },
    });
    expect(res.status()).toBe(401);
  });

  test("returns 405 for GET method", async ({ request }) => {
    const res = await request.get("/api/events/ingest");
    expect(res.status()).toBe(405);
  });
});
