import { expect, getTestPool, test } from "./fixtures";

// ---------------------------------------------------------------------------
// E2E admin revocation tests — verify that revoking an admin immediately
// terminates their admin sessions while leaving general sessions intact.
//
// Covers verification items from Discussion #9:
//   - 22: admin_eligible change → immediate session invalidation
//   - 39: admin_eligible=false defense in verifyJwtFull
// ---------------------------------------------------------------------------

const ORIGIN = "http://localhost:3000";

// =========================================================================
// Admin revocation — immediate session termination
// =========================================================================

test.describe("DELETE /api/admin/admins — revoke", () => {
  test("revoked admin's session is immediately invalidated", async ({
    adminPage,
    testData,
  }) => {
    const pool = getTestPool();

    // Create a second admin account in the DB
    const secondAdminId = testData.user.accountId;
    await pool.query(
      `UPDATE accounts SET admin_eligible = true WHERE id = $1`,
      [secondAdminId],
    );

    // Create an admin session for the second admin
    const sessionRes = await pool.query<{ sid: string }>(
      `INSERT INTO sessions
         (account_id, auth_context, ip_address, user_agent)
       VALUES ($1, 'admin', '127.0.0.1', 'Playwright E2E revoke')
       RETURNING sid`,
      [secondAdminId],
    );
    const secondAdminSid = sessionRes.rows[0].sid;

    // Inject admin cookies for the second admin into a new browser
    // context so we can verify their session independently.
    const { injectAuthCookies } = await import("./fixtures/auth");
    const baseURL = process.env.BASE_URL ?? "http://localhost:3000";
    const browser = adminPage.context().browser();
    if (!browser) throw new Error("Browser not available");
    const secondCtx = await browser.newContext({ baseURL });
    await injectAuthCookies(
      secondCtx,
      { accountId: secondAdminId, sessionId: secondAdminSid },
      "admin",
    );
    const secondAdminPage = await secondCtx.newPage();

    try {
      // 1. Verify second admin's session works
      const res1 = await secondAdminPage.request.get("/api/admin/admins");
      expect(res1.status()).toBe(200);

      // 2. First admin revokes the second admin
      const csrfCookies = await adminPage.context().cookies();
      const csrf =
        csrfCookies.find((c) => c.name === "csrf_admin")?.value ?? "";

      const revokeRes = await adminPage.request.delete(
        `/api/admin/admins/${secondAdminId}`,
        {
          headers: {
            origin: ORIGIN,
            "X-CSRF-Token-Admin": csrf,
          },
        },
      );
      expect(revokeRes.status()).toBe(204);

      // 3. Second admin's session is immediately invalid
      const res2 = await secondAdminPage.request.get("/api/admin/admins");
      expect(res2.status()).toBe(401);

      // 4. Verify DB state: admin sessions are revoked
      const sessions = await pool.query(
        `SELECT revoked, auth_context FROM sessions
         WHERE account_id = $1`,
        [secondAdminId],
      );
      const adminSessions = sessions.rows.filter(
        (r) => r.auth_context === "admin",
      );
      for (const row of adminSessions) {
        expect(row.revoked).toBe(true);
      }

      // 5. General sessions remain unaffected
      const generalSessions = sessions.rows.filter(
        (r) => r.auth_context === "general",
      );
      for (const row of generalSessions) {
        expect(row.revoked).toBe(false);
      }

      // 6. admin_eligible is now false
      const account = await pool.query(
        `SELECT admin_eligible FROM accounts WHERE id = $1`,
        [secondAdminId],
      );
      expect(account.rows[0].admin_eligible).toBe(false);
    } finally {
      await secondCtx.close();
      // Restore state for other tests
      await pool.query(
        `UPDATE accounts SET admin_eligible = false WHERE id = $1`,
        [secondAdminId],
      );
      await pool.query(`DELETE FROM sessions WHERE sid = $1`, [secondAdminSid]);
    }
  });

  test("admin cannot revoke self", async ({ adminPage, testData }) => {
    const csrfCookies = await adminPage.context().cookies();
    const csrf = csrfCookies.find((c) => c.name === "csrf_admin")?.value ?? "";

    const res = await adminPage.request.delete(
      `/api/admin/admins/${testData.admin.accountId}`,
      {
        headers: {
          origin: ORIGIN,
          "X-CSRF-Token-Admin": csrf,
        },
      },
    );

    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("cannot_revoke_self");
  });

  test("GET /api/admin/admins excludes revoked admin", async ({
    adminPage,
    testData,
  }) => {
    const pool = getTestPool();

    // Make user an admin
    const targetId = testData.user.accountId;
    await pool.query(
      `UPDATE accounts SET admin_eligible = true WHERE id = $1`,
      [targetId],
    );

    try {
      // Verify listed
      const res1 = await adminPage.request.get("/api/admin/admins");
      const body1 = await res1.json();
      expect(body1.admins.some((a: { id: string }) => a.id === targetId)).toBe(
        true,
      );

      // Revoke
      const csrfCookies = await adminPage.context().cookies();
      const csrf =
        csrfCookies.find((c) => c.name === "csrf_admin")?.value ?? "";

      await adminPage.request.delete(`/api/admin/admins/${targetId}`, {
        headers: {
          origin: ORIGIN,
          "X-CSRF-Token-Admin": csrf,
        },
      });

      // Verify no longer listed
      const res2 = await adminPage.request.get("/api/admin/admins");
      const body2 = await res2.json();
      expect(body2.admins.some((a: { id: string }) => a.id === targetId)).toBe(
        false,
      );
    } finally {
      await pool.query(
        `UPDATE accounts SET admin_eligible = false WHERE id = $1`,
        [targetId],
      );
    }
  });
});
