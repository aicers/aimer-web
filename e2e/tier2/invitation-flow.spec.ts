import { expect, getTestPool, test } from "../fixtures";
import { loginViaKeycloak } from "../fixtures/keycloak-login";
import {
  deleteAllMessages,
  extractInviteLink,
  waitForLatestMessageTo,
} from "../fixtures/mailpit";

// ---------------------------------------------------------------------------
// Tier-2 full-flow E2E — Discussion #9 item 42 (#452).
//
// Exercises the REAL analyst invitation acceptance path end to end:
//   admin sends → invited user clicks the email link → real Keycloak OIDC
//   sign-in → analyst designation.
//
// Tagged @tier2 so the per-PR `pnpm test:e2e` (chromium project, grepInvert
// /@tier2/) skips it. It runs only via `pnpm test:e2e:tier2` in the nightly
// workflow, which provides Keycloak + Mailpit alongside Postgres + OpenBao.
//
// Boundary: invitation CREATION by the admin is setup (cookie-injected admin
// context, the only allowed shortcut). The acceptance step under test goes
// through real OIDC — never cookie injection.
// ---------------------------------------------------------------------------

const ORIGIN = process.env.BASE_URL ?? "http://localhost:3000";
const SUCCESS_EMAIL = "invited-success@e2e.test";
const PASSWORD = process.env.E2E_USER_PASSWORD ?? "e2e-Passw0rd!";

// The invited account is created by the OIDC sign-in, so it lives outside the
// seedTestData lifecycle and must be torn down explicitly (by email).
async function cleanupInvited(email: string): Promise<void> {
  const pool = getTestPool();
  const accts = await pool.query<{ id: string }>(
    `SELECT id FROM accounts WHERE lower(email) = lower($1)`,
    [email],
  );
  for (const { id } of accts.rows) {
    await pool.query(
      `DELETE FROM analyst_customer_assignments WHERE account_id = $1`,
      [id],
    );
    await pool.query(`DELETE FROM sessions WHERE account_id = $1`, [id]);
    await pool.query(`DELETE FROM accounts WHERE id = $1`, [id]);
  }
  await pool.query(
    `DELETE FROM analyst_invitations WHERE lower(email) = lower($1)`,
    [email],
  );
}

test.describe("@tier2 Analyst invitation full flow — 42", () => {
  test("send → email link → real OIDC sign-in → designation", async ({
    adminPage,
    page,
    testData,
  }) => {
    await deleteAllMessages();

    try {
      // 1. Admin creates the analyst invitation for SUCCESS_EMAIL (setup).
      const csrf = (await adminPage.context().cookies()).find(
        (c) => c.name === "csrf_admin",
      )?.value;
      const createRes = await adminPage.request.post(
        "/api/admin/analysts/invitations",
        {
          headers: { origin: ORIGIN, "x-csrf-token": csrf ?? "" },
          data: { email: SUCCESS_EMAIL, customerIds: [testData.customer.id] },
        },
      );
      expect(createRes.status()).toBe(201);

      // 2. Read the real invitation link from the captured email.
      const msg = await waitForLatestMessageTo(SUCCESS_EMAIL);
      const inviteLink = await extractInviteLink(msg.ID);

      // 3. Click the link → app sets invitation_token cookie and 307s to OIDC.
      await page.goto(inviteLink);

      // 4. Real Keycloak sign-in as the MATCHING user → OIDC callback accepts.
      await loginViaKeycloak(page, {
        username: SUCCESS_EMAIL,
        password: PASSWORD,
      });

      // 5. Success: a normal general session was issued (not a deny redirect).
      expect(page.url()).not.toContain("/deny");
      const cookies = await page.context().cookies();
      expect(cookies.find((c) => c.name === "at")?.value).toBeTruthy();

      // 6. Designation landed on the OIDC-created account (keyed by email).
      const pool = getTestPool();
      const acct = await pool.query<{ id: string; analyst_eligible: boolean }>(
        `SELECT id, analyst_eligible FROM accounts WHERE lower(email) = lower($1)`,
        [SUCCESS_EMAIL],
      );
      expect(acct.rows).toHaveLength(1);
      expect(acct.rows[0].analyst_eligible).toBe(true);

      const assignment = await pool.query(
        `SELECT 1 FROM analyst_customer_assignments
         WHERE account_id = $1 AND customer_id = $2`,
        [acct.rows[0].id, testData.customer.id],
      );
      expect(assignment.rows).toHaveLength(1);

      const inv = await pool.query<{ status: string }>(
        `SELECT status FROM analyst_invitations WHERE lower(email) = lower($1)`,
        [SUCCESS_EMAIL],
      );
      expect(inv.rows[0]?.status).toBe("accepted");
    } finally {
      await cleanupInvited(SUCCESS_EMAIL);
    }
  });
});
