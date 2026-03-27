import { expect as baseExpect, test as baseTest } from "@playwright/test";
import { expect, test } from "./fixtures";

// ---------------------------------------------------------------------------
// E2E session policy tests — verify that the session policy API enforces
// admin-only access, validates input, and persists/returns policy values.
//
// Unauthenticated HTTP layer tests use base Playwright (no fixtures).
// Authenticated tests use the custom fixtures with admin/general sessions.
// ---------------------------------------------------------------------------

const ORIGIN = "http://localhost:3000";

// =========================================================================
// Unauthenticated — auth enforcement and method routing
// =========================================================================

baseTest.describe("GET /api/admin/session-policy — unauthenticated", () => {
  baseTest("returns 401 without auth cookie", async ({ request }) => {
    const res = await request.get("/api/admin/session-policy");
    baseExpect(res.status()).toBe(401);
    const body = await res.json();
    baseExpect(body.error).toBe("Unauthorized");
  });

  baseTest("returns 401 with invalid auth cookie", async ({ context }) => {
    await context.addCookies([
      {
        name: "at_admin",
        value: "invalid-jwt-token",
        domain: "localhost",
        path: "/",
      },
    ]);

    const res = await context.request.get("/api/admin/session-policy");
    baseExpect(res.status()).toBe(401);
  });
});

baseTest.describe("PUT /api/admin/session-policy — unauthenticated", () => {
  baseTest("returns 401 without auth cookie", async ({ request }) => {
    const res = await request.put("/api/admin/session-policy", {
      headers: { origin: ORIGIN },
      data: {},
    });
    baseExpect(res.status()).toBe(401);
    const body = await res.json();
    baseExpect(body.error).toBe("Unauthorized");
  });

  baseTest("returns 401 with invalid auth cookie", async ({ context }) => {
    await context.addCookies([
      {
        name: "at_admin",
        value: "invalid-jwt-token",
        domain: "localhost",
        path: "/",
      },
    ]);

    const res = await context.request.put("/api/admin/session-policy", {
      headers: { origin: ORIGIN },
      data: {},
    });
    baseExpect(res.status()).toBe(401);
  });
});

baseTest.describe("/api/admin/session-policy — unsupported methods", () => {
  baseTest("returns 405 for POST", async ({ request }) => {
    const res = await request.post("/api/admin/session-policy", {
      headers: { origin: ORIGIN },
      data: {},
    });
    baseExpect(res.status()).toBe(405);
  });

  baseTest("returns 405 for DELETE", async ({ request }) => {
    const res = await request.delete("/api/admin/session-policy");
    baseExpect(res.status()).toBe(405);
  });

  baseTest("returns 405 for PATCH", async ({ request }) => {
    const res = await request.patch("/api/admin/session-policy", {
      headers: { origin: ORIGIN },
      data: {},
    });
    baseExpect(res.status()).toBe(405);
  });
});

// =========================================================================
// Authenticated — admin can read and update policy
// =========================================================================

test.describe("GET /api/admin/session-policy — authenticated admin", () => {
  test("admin can read session policy", async ({ adminPage }) => {
    const res = await adminPage.request.get("/api/admin/session-policy");
    expect(res.status()).toBe(200);

    const body = await res.json();
    expect(body.policy).toBeDefined();
    expect(body.policy.general).toBeDefined();
    expect(body.policy.admin).toBeDefined();
    expect(typeof body.policy.general.idle_timeout_minutes).toBe("number");
    expect(typeof body.policy.general.absolute_timeout_minutes).toBe("number");
    expect(typeof body.policy.admin.idle_timeout_minutes).toBe("number");
    expect(typeof body.policy.admin.absolute_timeout_minutes).toBe("number");
  });
});

test.describe("PUT /api/admin/session-policy — authenticated admin", () => {
  test("admin can update session policy", async ({ adminPage }) => {
    const newPolicy = {
      general: { idle_timeout_minutes: 45, absolute_timeout_minutes: 600 },
      admin: { idle_timeout_minutes: 10, absolute_timeout_minutes: 90 },
    };

    // Read CSRF from cookies
    const cookies = await adminPage.context().cookies();
    const csrfValue = cookies.find((c) => c.name === "csrf_admin")?.value;
    expect(csrfValue).toBeDefined();

    const res = await adminPage.request.put("/api/admin/session-policy", {
      headers: { origin: ORIGIN, "x-csrf-token-admin": csrfValue as string },
      data: newPolicy,
    });
    expect(res.status()).toBe(200);

    const body = await res.json();
    expect(body.policy).toEqual(newPolicy);

    // Verify the change persisted by reading it back
    const getRes = await adminPage.request.get("/api/admin/session-policy");
    const getBody = await getRes.json();
    expect(getBody.policy).toEqual(newPolicy);

    // Clean up — restore defaults so other tests are not affected
    await adminPage.request.put("/api/admin/session-policy", {
      headers: { origin: ORIGIN, "x-csrf-token-admin": csrfValue as string },
      data: {
        general: { idle_timeout_minutes: 30, absolute_timeout_minutes: 480 },
        admin: { idle_timeout_minutes: 15, absolute_timeout_minutes: 120 },
      },
    });
  });

  test("rejects idle floor violation", async ({ adminPage }) => {
    const cookies = await adminPage.context().cookies();
    const csrfValue = cookies.find((c) => c.name === "csrf_admin")?.value;

    const res = await adminPage.request.put("/api/admin/session-policy", {
      headers: { origin: ORIGIN, "x-csrf-token-admin": csrfValue as string },
      data: {
        general: { idle_timeout_minutes: 2, absolute_timeout_minutes: 480 },
        admin: { idle_timeout_minutes: 15, absolute_timeout_minutes: 120 },
      },
    });
    expect(res.status()).toBe(400);

    const body = await res.json();
    expect(body.error).toContain("idle_timeout_minutes must be at least");
  });

  test("rejects absolute floor violation", async ({ adminPage }) => {
    const cookies = await adminPage.context().cookies();
    const csrfValue = cookies.find((c) => c.name === "csrf_admin")?.value;

    const res = await adminPage.request.put("/api/admin/session-policy", {
      headers: { origin: ORIGIN, "x-csrf-token-admin": csrfValue as string },
      data: {
        general: { idle_timeout_minutes: 30, absolute_timeout_minutes: 480 },
        admin: { idle_timeout_minutes: 15, absolute_timeout_minutes: 30 },
      },
    });
    expect(res.status()).toBe(400);

    const body = await res.json();
    expect(body.error).toContain("absolute_timeout_minutes must be at least");
  });

  test("rejects PUT without CSRF token", async ({ adminPage }) => {
    const res = await adminPage.request.put("/api/admin/session-policy", {
      headers: { origin: ORIGIN },
      data: {
        general: { idle_timeout_minutes: 30, absolute_timeout_minutes: 480 },
        admin: { idle_timeout_minutes: 15, absolute_timeout_minutes: 120 },
      },
    });
    expect(res.status()).toBe(403);
    const body = await res.json();
    expect(body.error).toBe("CSRF token required");
  });

  test("rejects PUT with wrong origin", async ({ adminPage }) => {
    const cookies = await adminPage.context().cookies();
    const csrfValue = cookies.find((c) => c.name === "csrf_admin")?.value;

    const res = await adminPage.request.put("/api/admin/session-policy", {
      headers: {
        origin: "https://evil.example.com",
        "x-csrf-token-admin": csrfValue as string,
      },
      data: {
        general: { idle_timeout_minutes: 30, absolute_timeout_minutes: 480 },
        admin: { idle_timeout_minutes: 15, absolute_timeout_minutes: 120 },
      },
    });
    expect(res.status()).toBe(403);
    const body = await res.json();
    expect(body.error).toBe("Origin mismatch");
  });

  test("rejects invalid JSON body structure", async ({ adminPage }) => {
    const cookies = await adminPage.context().cookies();
    const csrfValue = cookies.find((c) => c.name === "csrf_admin")?.value;

    const res = await adminPage.request.put("/api/admin/session-policy", {
      headers: { origin: ORIGIN, "x-csrf-token-admin": csrfValue as string },
      data: { general: { idle_timeout_minutes: "not-a-number" } },
    });
    expect(res.status()).toBe(400);
  });
});

// =========================================================================
// Authenticated — updated policy does not break subsequent auth
// =========================================================================

test.describe("Session policy — post-update auth smoke test", () => {
  test("admin request succeeds after policy tightened to minimum", async ({
    adminPage,
  }) => {
    const cookies = await adminPage.context().cookies();
    const csrfValue = cookies.find((c) => c.name === "csrf_admin")?.value;
    expect(csrfValue).toBeDefined();

    // Tighten policy to minimum allowed values and verify the subsequent
    // authenticated GET still succeeds (the session is fresh, so it passes
    // under any valid policy). This is a smoke test — it confirms that
    // the full withAuth → getSessionPolicy → validateSession path does not
    // error after an update, but does not prove cache invalidation on its
    // own (that would require a session whose age falls between old and
    // new thresholds, which is impractical in E2E without DB manipulation).
    const tightPolicy = {
      general: { idle_timeout_minutes: 5, absolute_timeout_minutes: 60 },
      admin: { idle_timeout_minutes: 5, absolute_timeout_minutes: 60 },
    };

    const putRes = await adminPage.request.put("/api/admin/session-policy", {
      headers: { origin: ORIGIN, "x-csrf-token-admin": csrfValue as string },
      data: tightPolicy,
    });
    expect(putRes.status()).toBe(200);

    const getRes = await adminPage.request.get("/api/admin/session-policy");
    expect(getRes.status()).toBe(200);
    const body = await getRes.json();
    expect(body.policy).toEqual(tightPolicy);

    // Restore defaults
    await adminPage.request.put("/api/admin/session-policy", {
      headers: { origin: ORIGIN, "x-csrf-token-admin": csrfValue as string },
      data: {
        general: { idle_timeout_minutes: 30, absolute_timeout_minutes: 480 },
        admin: { idle_timeout_minutes: 15, absolute_timeout_minutes: 120 },
      },
    });
  });
});

// =========================================================================
// Authenticated — general-context user cannot access admin endpoint
// =========================================================================

test.describe("Session policy — general context rejection", () => {
  test("general-context user gets 401 on admin endpoint", async ({
    managerPage,
  }) => {
    // General-context cookies (at, csrf) are set, but admin endpoint
    // requires admin-context cookies (at_admin, csrf_admin).
    const res = await managerPage.request.get("/api/admin/session-policy");
    expect(res.status()).toBe(401);
  });
});
