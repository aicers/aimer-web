import { expect, getTestPool, test } from "./fixtures";

// ---------------------------------------------------------------------------
// E2E account suspension tests — verify that account suspension and
// unsuspension work correctly via the admin API and that session
// termination is immediate.
//
// Covers verification items from Discussion #9:
//   - Account suspension immediately terminates all sessions
//   - Admin cannot suspend their own account
//   - Unsuspension restores account access
// ---------------------------------------------------------------------------

const ORIGIN = "http://localhost:3000";

// =========================================================================
// Admin can list accounts
// =========================================================================

test.describe("GET /api/admin/accounts — authenticated", () => {
  test("admin can list all accounts", async ({ adminPage, testData }) => {
    const res = await adminPage.request.get("/api/admin/accounts");
    expect(res.status()).toBe(200);

    const body = await res.json();
    expect(body.accounts).toBeDefined();
    expect(body.accounts.length).toBeGreaterThanOrEqual(5);

    // Verify seeded accounts appear
    const accountIds = body.accounts.map((a: { id: string }) => a.id);
    expect(accountIds).toContain(testData.admin.accountId);
    expect(accountIds).toContain(testData.user.accountId);
    expect(accountIds).toContain(testData.manager.accountId);
  });

  test("accounts include expected fields", async ({ adminPage }) => {
    const res = await adminPage.request.get("/api/admin/accounts");
    const body = await res.json();
    const account = body.accounts[0];

    expect(account).toHaveProperty("id");
    expect(account).toHaveProperty("username");
    expect(account).toHaveProperty("displayName");
    expect(account).toHaveProperty("email");
    expect(account).toHaveProperty("status");
    expect(account).toHaveProperty("lastSignInAt");
    expect(account).toHaveProperty("adminEligible");
    expect(account).toHaveProperty("analystEligible");
    expect(account).toHaveProperty("createdAt");
  });

  test("general-context session cannot list accounts", async ({
    managerPage,
  }) => {
    const res = await managerPage.request.get("/api/admin/accounts");
    expect(res.status()).toBe(401);
  });
});

// =========================================================================
// Account suspension — immediate session termination
// =========================================================================

test.describe("PATCH /api/admin/accounts — suspend", () => {
  test("admin can suspend a user account", async ({ adminPage, testData }) => {
    const csrfCookies = await adminPage.context().cookies();
    const csrf = csrfCookies.find((c) => c.name === "csrf_admin")?.value ?? "";

    const res = await adminPage.request.patch(
      `/api/admin/accounts/${testData.user.accountId}`,
      {
        headers: {
          origin: ORIGIN,
          "X-CSRF-Token-Admin": csrf,
        },
        data: { status: "suspended" },
      },
    );

    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("suspended");

    // Restore for other tests
    const pool = getTestPool();
    await pool.query(
      `UPDATE accounts SET status = 'active', token_version = 0 WHERE id = $1`,
      [testData.user.accountId],
    );
    await pool.query(
      `UPDATE sessions SET revoked = false WHERE account_id = $1`,
      [testData.user.accountId],
    );
  });

  test("suspended user's session is immediately invalidated", async ({
    adminPage,
    userPage,
    testData,
  }) => {
    // 1. Verify user session works
    const res1 = await userPage.request.get("/api/auth/me");
    expect(res1.status()).toBe(200);

    // 2. Admin suspends the user
    const csrfCookies = await adminPage.context().cookies();
    const csrf = csrfCookies.find((c) => c.name === "csrf_admin")?.value ?? "";

    const suspendRes = await adminPage.request.patch(
      `/api/admin/accounts/${testData.user.accountId}`,
      {
        headers: {
          origin: ORIGIN,
          "X-CSRF-Token-Admin": csrf,
        },
        data: { status: "suspended" },
      },
    );
    expect(suspendRes.status()).toBe(200);

    // 3. User's session is immediately invalid
    const res2 = await userPage.request.get("/api/auth/me");
    expect(res2.status()).toBe(401);

    // Restore for other tests
    const pool = getTestPool();
    await pool.query(
      `UPDATE accounts SET status = 'active', token_version = 0 WHERE id = $1`,
      [testData.user.accountId],
    );
    await pool.query(
      `UPDATE sessions SET revoked = false WHERE account_id = $1`,
      [testData.user.accountId],
    );
  });

  test("all sessions for suspended account are revoked in DB", async ({
    adminPage,
    testData,
  }) => {
    const csrfCookies = await adminPage.context().cookies();
    const csrf = csrfCookies.find((c) => c.name === "csrf_admin")?.value ?? "";

    await adminPage.request.patch(
      `/api/admin/accounts/${testData.user.accountId}`,
      {
        headers: {
          origin: ORIGIN,
          "X-CSRF-Token-Admin": csrf,
        },
        data: { status: "suspended" },
      },
    );

    // Verify DB state
    const pool = getTestPool();
    const sessions = await pool.query(
      `SELECT revoked FROM sessions WHERE account_id = $1`,
      [testData.user.accountId],
    );
    for (const row of sessions.rows) {
      expect(row.revoked).toBe(true);
    }

    const account = await pool.query(
      `SELECT token_version FROM accounts WHERE id = $1`,
      [testData.user.accountId],
    );
    expect(account.rows[0].token_version).toBeGreaterThan(0);

    // Restore
    await pool.query(
      `UPDATE accounts SET status = 'active', token_version = 0 WHERE id = $1`,
      [testData.user.accountId],
    );
    await pool.query(
      `UPDATE sessions SET revoked = false WHERE account_id = $1`,
      [testData.user.accountId],
    );
  });

  test("admin cannot suspend their own account", async ({
    adminPage,
    testData,
  }) => {
    const csrfCookies = await adminPage.context().cookies();
    const csrf = csrfCookies.find((c) => c.name === "csrf_admin")?.value ?? "";

    const res = await adminPage.request.patch(
      `/api/admin/accounts/${testData.admin.accountId}`,
      {
        headers: {
          origin: ORIGIN,
          "X-CSRF-Token-Admin": csrf,
        },
        data: { status: "suspended" },
      },
    );

    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("cannot_suspend_self");
  });

  test("returns 400 for invalid status value", async ({
    adminPage,
    testData,
  }) => {
    const csrfCookies = await adminPage.context().cookies();
    const csrf = csrfCookies.find((c) => c.name === "csrf_admin")?.value ?? "";

    const res = await adminPage.request.patch(
      `/api/admin/accounts/${testData.user.accountId}`,
      {
        headers: {
          origin: ORIGIN,
          "X-CSRF-Token-Admin": csrf,
        },
        data: { status: "deleted" },
      },
    );

    expect(res.status()).toBe(400);
  });

  test("returns 404 for non-existent account", async ({ adminPage }) => {
    const csrfCookies = await adminPage.context().cookies();
    const csrf = csrfCookies.find((c) => c.name === "csrf_admin")?.value ?? "";

    const res = await adminPage.request.patch(
      "/api/admin/accounts/00000000-0000-0000-0000-000000000000",
      {
        headers: {
          origin: ORIGIN,
          "X-CSRF-Token-Admin": csrf,
        },
        data: { status: "suspended" },
      },
    );

    expect(res.status()).toBe(404);
  });
});

// =========================================================================
// Account unsuspension
// =========================================================================

test.describe("PATCH /api/admin/accounts — unsuspend", () => {
  test("admin can unsuspend a suspended account", async ({
    adminPage,
    testData,
  }) => {
    // Suspend first via DB
    const pool = getTestPool();
    await pool.query(`UPDATE accounts SET status = 'suspended' WHERE id = $1`, [
      testData.user.accountId,
    ]);

    const csrfCookies = await adminPage.context().cookies();
    const csrf = csrfCookies.find((c) => c.name === "csrf_admin")?.value ?? "";

    const res = await adminPage.request.patch(
      `/api/admin/accounts/${testData.user.accountId}`,
      {
        headers: {
          origin: ORIGIN,
          "X-CSRF-Token-Admin": csrf,
        },
        data: { status: "active" },
      },
    );

    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("active");

    // Verify DB state
    const account = await pool.query(
      `SELECT status FROM accounts WHERE id = $1`,
      [testData.user.accountId],
    );
    expect(account.rows[0].status).toBe("active");
  });

  test("returns 409 when trying to change a disabled account", async ({
    adminPage,
    testData,
  }) => {
    // Disable account via DB
    const pool = getTestPool();
    await pool.query(`UPDATE accounts SET status = 'disabled' WHERE id = $1`, [
      testData.user.accountId,
    ]);

    const csrfCookies = await adminPage.context().cookies();
    const csrf = csrfCookies.find((c) => c.name === "csrf_admin")?.value ?? "";

    try {
      const res = await adminPage.request.patch(
        `/api/admin/accounts/${testData.user.accountId}`,
        {
          headers: {
            origin: ORIGIN,
            "X-CSRF-Token-Admin": csrf,
          },
          data: { status: "active" },
        },
      );

      expect(res.status()).toBe(409);
    } finally {
      await pool.query(`UPDATE accounts SET status = 'active' WHERE id = $1`, [
        testData.user.accountId,
      ]);
    }
  });

  test("no-op when status already matches", async ({ adminPage, testData }) => {
    const csrfCookies = await adminPage.context().cookies();
    const csrf = csrfCookies.find((c) => c.name === "csrf_admin")?.value ?? "";

    // User is already active
    const res = await adminPage.request.patch(
      `/api/admin/accounts/${testData.user.accountId}`,
      {
        headers: {
          origin: ORIGIN,
          "X-CSRF-Token-Admin": csrf,
        },
        data: { status: "active" },
      },
    );

    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("active");
  });
});
