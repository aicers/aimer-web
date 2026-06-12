import type { NextRequest } from "next/server";
import { withAuth } from "@/lib/auth/guards";
import { getAuthPool, query } from "@/lib/db/client";

export const GET = withAuth(async (_req: NextRequest, auth) => {
  const rows = await query<{
    username: string;
    display_name: string;
    email: string | null;
    locale: string | null;
    timezone: string | null;
    time_format_locale: string | null;
    time_format_hour_cycle: "h12" | "h23" | null;
    time_format_seconds: boolean | null;
    time_format_tz_label: boolean | null;
    analyst_eligible: boolean;
  }>(
    getAuthPool(),
    `SELECT username, display_name, email, locale, timezone,
            time_format_locale, time_format_hour_cycle,
            time_format_seconds, time_format_tz_label, analyst_eligible
     FROM accounts WHERE id = $1`,
    [auth.accountId],
  );

  if (rows.length === 0) {
    return Response.json({ error: "Account not found" }, { status: 404 });
  }

  const memberships = await query<{
    customer_id: string;
    customer_name: string;
    role_id: number;
    role_name: string;
  }>(
    getAuthPool(),
    `SELECT c.id AS customer_id, c.name AS customer_name,
            r.id AS role_id, r.name AS role_name
     FROM account_customer_memberships acm
     JOIN customers c ON c.id = acm.customer_id
     JOIN roles r ON r.id = acm.role_id
     WHERE acm.account_id = $1
     ORDER BY c.name`,
    [auth.accountId],
  );

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
    timeFormatLocale: account.time_format_locale,
    timeFormatHourCycle: account.time_format_hour_cycle,
    timeFormatSeconds: account.time_format_seconds,
    timeFormatTzLabel: account.time_format_tz_label,
    analystEligible: account.analyst_eligible,
    bridge: {
      active: auth.bridgeAiceId !== null,
      aiceId: auth.bridgeAiceId,
      customerIds: auth.bridgeCustomerIds,
    },
    memberships: memberships.map((m) => ({
      customerId: m.customer_id,
      customerName: m.customer_name,
      roleId: m.role_id,
      roleName: m.role_name,
    })),
  });
});
