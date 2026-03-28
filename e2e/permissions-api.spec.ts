import { expect, test } from "./fixtures";

// ---------------------------------------------------------------------------
// E2E tests for the permissions-related API endpoints added in issue #31:
//   GET /api/auth/me      — updated fields (analystEligible, bridge)
//   GET /api/auth/customers — customer list with role and isAnalyst
//   GET /api/auth/environments — environment list per customer
// ---------------------------------------------------------------------------

// =========================================================================
// GET /api/auth/me — updated fields
// =========================================================================

test.describe("GET /api/auth/me — updated fields", () => {
  test("includes analystEligible field", async ({
    multiRolePage,
    testData,
  }) => {
    const res = await multiRolePage.request.get("/api/auth/me");
    expect(res.status()).toBe(200);

    const body = await res.json();
    expect(body.accountId).toBe(testData.multiRole.accountId);
    expect(body.analystEligible).toBe(true);
  });

  test("includes bridge object", async ({ multiRolePage }) => {
    const res = await multiRolePage.request.get("/api/auth/me");
    expect(res.status()).toBe(200);

    const body = await res.json();
    expect(body.bridge).toEqual({
      active: false,
      aiceId: null,
      customerIds: null,
    });
  });
});

// =========================================================================
// GET /api/auth/customers
// =========================================================================

test.describe("GET /api/auth/customers", () => {
  test("returns customers with role and isAnalyst fields", async ({
    multiRolePage,
    testData,
  }) => {
    const res = await multiRolePage.request.get("/api/auth/customers");
    expect(res.status()).toBe(200);

    const body = await res.json();
    expect(body.customers).toBeDefined();
    expect(body.customers.length).toBeGreaterThanOrEqual(2);

    // Customer A: User role + analyst assignment
    const custA = body.customers.find(
      (c: { id: string }) => c.id === testData.customer.id,
    );
    expect(custA).toBeDefined();
    expect(custA.role).toBe("User");
    expect(custA.isAnalyst).toBe(true);

    // Customer B: Manager role, no analyst assignment
    const custB = body.customers.find(
      (c: { id: string }) => c.id === testData.customerB.id,
    );
    expect(custB).toBeDefined();
    expect(custB.role).toBe("Manager");
    expect(custB.isAnalyst).toBe(false);
  });

  test("returns customer list for manager", async ({
    managerPage,
    testData,
  }) => {
    const res = await managerPage.request.get("/api/auth/customers");
    expect(res.status()).toBe(200);

    const body = await res.json();
    expect(body.customers).toBeDefined();
    expect(Array.isArray(body.customers)).toBe(true);
    expect(body.customers.length).toBeGreaterThanOrEqual(1);

    const cust = body.customers.find(
      (c: { id: string }) => c.id === testData.customer.id,
    );
    expect(cust).toBeDefined();
    expect(cust).toHaveProperty("id");
    expect(cust).toHaveProperty("name");
    expect(cust).toHaveProperty("externalKey");
    expect(cust).toHaveProperty("role");
    expect(cust).toHaveProperty("isAnalyst");
  });

  test("returns analyst-only access (no membership)", async ({
    analystPage,
    testData,
  }) => {
    const res = await analystPage.request.get("/api/auth/customers");
    expect(res.status()).toBe(200);

    const body = await res.json();
    const cust = body.customers.find(
      (c: { id: string }) => c.id === testData.customer.id,
    );
    expect(cust).toBeDefined();
    expect(cust.role).toBeNull();
    expect(cust.isAnalyst).toBe(true);
  });

  test("user without analyst_eligible sees isAnalyst=false", async ({
    userPage,
    testData,
  }) => {
    const res = await userPage.request.get("/api/auth/customers");
    expect(res.status()).toBe(200);

    const body = await res.json();
    const cust = body.customers.find(
      (c: { id: string }) => c.id === testData.customer.id,
    );
    expect(cust).toBeDefined();
    expect(cust.role).toBe("User");
    expect(cust.isAnalyst).toBe(false);
  });

  test("returns 401 for unauthenticated request", async ({ browser }) => {
    // Create a fresh context with no auth cookies
    const context = await browser.newContext();
    const page = await context.newPage();

    const res = await page.request.get("/api/auth/customers");
    expect(res.status()).toBe(401);

    await context.close();
  });
});

// =========================================================================
// GET /api/auth/environments
// =========================================================================

test.describe("GET /api/auth/environments", () => {
  test("returns environments for valid customer_id", async ({
    managerPage,
    testData,
  }) => {
    const res = await managerPage.request.get(
      `/api/auth/environments?customer_id=${testData.customer.id}`,
    );
    expect(res.status()).toBe(200);

    const body = await res.json();
    expect(body.environments).toBeDefined();
    expect(Array.isArray(body.environments)).toBe(true);
  });

  test("returns 400 for missing customer_id", async ({ managerPage }) => {
    const res = await managerPage.request.get("/api/auth/environments");
    expect(res.status()).toBe(400);

    const body = await res.json();
    expect(body.error).toBe("customer_id query parameter is required");
  });

  test("returns 400 for invalid UUID", async ({ managerPage }) => {
    const res = await managerPage.request.get(
      "/api/auth/environments?customer_id=not-a-uuid",
    );
    expect(res.status()).toBe(400);

    const body = await res.json();
    expect(body.error).toBe("Invalid customer_id format");
  });
});
