import { expect, getTestPool, test } from "../fixtures";
import { loginViaKeycloak } from "../fixtures/keycloak-login";
import {
  deleteAllMessages,
  extractInviteLink,
  waitForLatestMessageTo,
} from "../fixtures/mailpit";

// ---------------------------------------------------------------------------
// OIDC full-flow E2E — Discussion #9 item 42-1 (#452).
//
// Email-mismatch path: an invitation issued for one email is opened, but the
// user signs in with a DIFFERENT account. Acceptance must be denied, no
// analyst designation is created, and the invitation row stays `pending`
// (email_mismatch is a retryable reason — see
// src/lib/auth/analyst-invitations.ts).
//
// See invitation-flow.spec.ts for the @oidc / boundary rationale.
// ---------------------------------------------------------------------------

const ORIGIN = process.env.BASE_URL ?? "http://localhost:3000";
const INVITED_EMAIL = "invited-success@e2e.test"; // who the invite is FOR
const MISMATCH_EMAIL = "invited-mismatch@e2e.test"; // who actually signs in
const PASSWORD = process.env.E2E_USER_PASSWORD ?? "e2e-Passw0rd!";

// Both the invitation (keyed by INVITED_EMAIL) and the OIDC-created mismatch
// account (keyed by MISMATCH_EMAIL) live outside seedTestData; tear both down.
async function cleanup(emails: string[]): Promise<void> {
  const pool = getTestPool();
  for (const email of emails) {
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
}

test.describe("@oidc Analyst invitation email mismatch — 42-1", () => {
  test("signing in with a non-matching account is denied; invitation stays pending", async ({
    adminPage,
    page,
    testData,
  }) => {
    await deleteAllMessages();

    try {
      // 1. Admin creates the invitation for INVITED_EMAIL (setup).
      const csrf = (await adminPage.context().cookies()).find(
        (c) => c.name === "csrf_admin",
      )?.value;
      const createRes = await adminPage.request.post(
        "/api/admin/analysts/invitations",
        {
          headers: { origin: ORIGIN, "X-CSRF-Token-Admin": csrf ?? "" },
          data: { email: INVITED_EMAIL, customerIds: [testData.customer.id] },
        },
      );
      expect(createRes.status()).toBe(201);

      // 2. Read the real invitation link.
      const msg = await waitForLatestMessageTo(INVITED_EMAIL);
      const inviteLink = await extractInviteLink(msg.ID);

      // 3. Click the link, then sign in as the MISMATCHED user.
      await page.goto(inviteLink);
      await loginViaKeycloak(page, {
        username: MISMATCH_EMAIL,
        password: PASSWORD,
      });

      // 4. Denied: landed on the deny page with the email-mismatch reason.
      await expect(page).toHaveURL(/\/deny\?reason=invitation_email_mismatch/);

      // 5. No designation for the mismatched account.
      const pool = getTestPool();
      const mismatchAcct = await pool.query<{
        id: string;
        analyst_eligible: boolean;
      }>(
        `SELECT id, analyst_eligible FROM accounts WHERE lower(email) = lower($1)`,
        [MISMATCH_EMAIL],
      );
      if (mismatchAcct.rows.length > 0) {
        const { id, analyst_eligible } = mismatchAcct.rows[0];
        expect(analyst_eligible).toBe(false);
        const assignment = await pool.query(
          `SELECT 1 FROM analyst_customer_assignments WHERE account_id = $1`,
          [id],
        );
        expect(assignment.rows).toHaveLength(0);
      }

      // 6. The invitation is untouched — still pending (retryable reason).
      const inv = await pool.query<{ status: string }>(
        `SELECT status FROM analyst_invitations WHERE lower(email) = lower($1)`,
        [INVITED_EMAIL],
      );
      expect(inv.rows[0]?.status).toBe("pending");
    } finally {
      await cleanup([INVITED_EMAIL, MISMATCH_EMAIL]);
    }
  });
});
