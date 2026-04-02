import { assertAuthorized } from "@/lib/auth/authorization";
import { HttpError } from "@/lib/auth/errors";
import { withAuth } from "@/lib/auth/guards";
import { getAuthPool } from "@/lib/db/client";

export const GET = withAuth(
  async (_req, auth) => {
    const pool = getAuthPool();
    const client = await pool.connect();
    try {
      await assertAuthorized(client, "admin", auth.accountId, "accounts:read");
    } catch (err) {
      if (err instanceof HttpError) {
        return Response.json(
          { error: err.message },
          { status: err.statusCode },
        );
      }
      throw err;
    } finally {
      client.release();
    }

    const result = await pool.query<{
      id: string;
      username: string;
      display_name: string | null;
      email: string | null;
      status: string;
      last_sign_in_at: string | null;
      admin_eligible: boolean;
      analyst_eligible: boolean;
      created_at: string;
    }>(
      `SELECT id, username, display_name, email, status,
              last_sign_in_at, admin_eligible, analyst_eligible, created_at
       FROM accounts
       ORDER BY created_at`,
    );

    return Response.json({
      accounts: result.rows.map((r) => ({
        id: r.id,
        username: r.username,
        displayName: r.display_name,
        email: r.email,
        status: r.status,
        lastSignInAt: r.last_sign_in_at,
        adminEligible: r.admin_eligible,
        analystEligible: r.analyst_eligible,
        createdAt: r.created_at,
      })),
    });
  },
  { ctx: "admin" },
);
