import type { NextRequest } from "next/server";
import { withAuth } from "@/lib/auth/guards";
import { getAuthPool, query } from "@/lib/db/client";

export const GET = withAuth(
  async (_req: NextRequest, auth) => {
    const rows = await query<{
      username: string;
      display_name: string;
      email: string | null;
      locale: string | null;
      timezone: string | null;
    }>(
      getAuthPool(),
      `SELECT username, display_name, email, locale, timezone
       FROM accounts WHERE id = $1`,
      [auth.accountId],
    );

    if (rows.length === 0) {
      return Response.json({ error: "Account not found" }, { status: 404 });
    }

    const account = rows[0];
    return Response.json({
      accountId: auth.accountId,
      sessionId: auth.sessionId,
      authContext: auth.authContext,
      username: account.username,
      displayName: account.display_name,
      email: account.email,
      locale: account.locale,
      timezone: account.timezone,
    });
  },
  { ctx: "admin" },
);
