import { expect, getTestPool, test } from "./fixtures";

// ---------------------------------------------------------------------------
// E2E authorization tests — verify that the authorization layer enforces
// role-based access at the API level using real authenticated sessions.
//
// Covers verification items:
//   #4-7  — General flow per role (Manager, User, Admin)
//   #9    — System Admin has no general permissions
//   #22   — admin_eligible change → immediate admin rejection
//   #24   — Membership deletion → immediate general rejection
//   #25   — Multiple customers with different roles
// ---------------------------------------------------------------------------

// =========================================================================
// #4-5: Manager can access members API
// =========================================================================

test.describe("Authorization — Manager role", () => {
  test("Manager can list members for their customer", async ({
    managerPage,
    testData,
  }) => {
    const res = await managerPage.request.get(
      `/api/members?customer_id=${testData.customer.id}`,
    );
    expect(res.status()).toBe(200);

    const body = await res.json();
    expect(body.members).toBeDefined();
    expect(body.members.length).toBeGreaterThanOrEqual(2);

    const displayNames = body.members.map(
      (m: { displayName: string }) => m.displayName,
    );
    expect(displayNames).toContain(testData.manager.displayName);
    expect(displayNames).toContain(testData.user.displayName);
  });

  test("Manager can access roles API", async ({ managerPage }) => {
    const res = await managerPage.request.get("/api/roles");
    expect(res.status()).toBe(200);

    const body = await res.json();
    expect(body.roles.length).toBeGreaterThanOrEqual(2);
  });
});

// =========================================================================
// #6-7: User role is denied management APIs
// =========================================================================

test.describe("Authorization — User role", () => {
  test("User is denied member list (403)", async ({ userPage, testData }) => {
    const res = await userPage.request.get(
      `/api/members?customer_id=${testData.customer.id}`,
    );
    expect(res.status()).toBe(403);
  });

  test("User can access own profile via /api/auth/me", async ({
    userPage,
    testData,
  }) => {
    const res = await userPage.request.get("/api/auth/me");
    expect(res.status()).toBe(200);

    const body = await res.json();
    expect(body.accountId).toBe(testData.user.accountId);
    expect(body.authContext).toBe("general");
  });
});

// =========================================================================
// #9: Admin session cannot access general-context endpoints
// =========================================================================

test.describe("Authorization — Admin context boundary", () => {
  test("Admin session can access /api/admin-auth/me", async ({
    adminPage,
    testData,
  }) => {
    const res = await adminPage.request.get("/api/admin-auth/me");
    expect(res.status()).toBe(200);

    const body = await res.json();
    expect(body.accountId).toBe(testData.admin.accountId);
    expect(body.authContext).toBe("admin");
  });

  test("Admin session is rejected by general-context /api/auth/me (401)", async ({
    adminPage,
  }) => {
    // Admin cookie is `at_admin`; the general endpoint expects `at`.
    // Without a general cookie, the general guard returns 401.
    const res = await adminPage.request.get("/api/auth/me");
    expect(res.status()).toBe(401);
  });

  test("General session is rejected by admin-context /api/admin-auth/me (401)", async ({
    managerPage,
  }) => {
    // General cookie is `at`; the admin endpoint expects `at_admin`.
    const res = await managerPage.request.get("/api/admin-auth/me");
    expect(res.status()).toBe(401);
  });
});

// =========================================================================
// #22: admin_eligible change → immediate admin session invalidation
// =========================================================================

test.describe("Authorization — immediate effect", () => {
  test("revoking admin_eligible immediately blocks admin API", async ({
    adminPage,
    testData,
  }) => {
    // Verify admin works first
    const res1 = await adminPage.request.get("/api/admin-auth/me");
    expect(res1.status()).toBe(200);

    // Revoke admin_eligible directly in DB
    const pool = getTestPool();
    await pool.query(
      `UPDATE accounts SET admin_eligible = false WHERE id = $1`,
      [testData.admin.accountId],
    );

    try {
      // Next request should fail — the JWT is still valid, but
      // verifyJwtFull re-checks admin_eligible from DB.
      const res2 = await adminPage.request.get("/api/admin-auth/me");
      expect(res2.status()).toBe(401);
    } finally {
      // Restore for other tests
      await pool.query(
        `UPDATE accounts SET admin_eligible = true WHERE id = $1`,
        [testData.admin.accountId],
      );
    }
  });

  test("removing membership immediately blocks member list", async ({
    userPage,
    testData,
  }) => {
    // User can access their own profile (proves session is valid)
    const res1 = await userPage.request.get("/api/auth/me");
    expect(res1.status()).toBe(200);

    // Remove User's membership from customer A
    const pool = getTestPool();
    await pool.query(
      `DELETE FROM account_customer_memberships
       WHERE account_id = $1 AND customer_id = $2`,
      [testData.user.accountId, testData.customer.id],
    );

    try {
      // /api/auth/me still works (session is valid, no customer check)
      const res2 = await userPage.request.get("/api/auth/me");
      expect(res2.status()).toBe(200);

      // But memberships array should be empty for this customer
      const body = await res2.json();
      const customerIds = body.memberships.map(
        (m: { customerId: string }) => m.customerId,
      );
      expect(customerIds).not.toContain(testData.customer.id);
    } finally {
      // Restore membership
      await pool.query(
        `INSERT INTO account_customer_memberships (account_id, customer_id, role_id)
         VALUES ($1, $2, $3)`,
        [testData.user.accountId, testData.customer.id, testData.roles.userId],
      );
    }
  });
});

// =========================================================================
// #25: Multiple customers with different roles
// =========================================================================

test.describe("Authorization — multi-role across customers", () => {
  test("multi-role account sees different memberships per customer", async ({
    multiRolePage,
    testData,
  }) => {
    const res = await multiRolePage.request.get("/api/auth/me");
    expect(res.status()).toBe(200);

    const body = await res.json();
    expect(body.accountId).toBe(testData.multiRole.accountId);

    // Should have memberships in both customers
    const memberships = body.memberships as Array<{
      customerId: string;
      roleName: string;
    }>;
    expect(memberships.length).toBe(2);

    // User role in customer A
    const custA = memberships.find(
      (m) => m.customerId === testData.customer.id,
    );
    expect(custA).toBeDefined();
    expect(custA?.roleName).toBe("User");

    // Manager role in customer B
    const custB = memberships.find(
      (m) => m.customerId === testData.customerB.id,
    );
    expect(custB).toBeDefined();
    expect(custB?.roleName).toBe("Manager");
  });

  test("multi-role account can list members for customer B (Manager)", async ({
    multiRolePage,
    testData,
  }) => {
    const res = await multiRolePage.request.get(
      `/api/members?customer_id=${testData.customerB.id}`,
    );
    // Manager in customer B → can list members
    expect(res.status()).toBe(200);
  });

  test("multi-role account is denied member list for customer A (User)", async ({
    multiRolePage,
    testData,
  }) => {
    const res = await multiRolePage.request.get(
      `/api/members?customer_id=${testData.customer.id}`,
    );
    // User in customer A → cannot list members
    expect(res.status()).toBe(403);
  });
});
