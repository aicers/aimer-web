import type { NextRequest } from "next/server";
import { assertAuthorized } from "@/lib/auth/authorization";
import { HttpError } from "@/lib/auth/errors";
import { withAuth } from "@/lib/auth/guards";
import { getAuditPool, getAuthPool } from "@/lib/db/client";

export const GET = withAuth(
  async (_req: NextRequest, auth) => {
    const authPool = getAuthPool();
    const client = await authPool.connect();
    try {
      await assertAuthorized(
        client,
        "admin",
        auth.accountId,
        "audit-logs:read",
      );
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

    const auditPool = getAuditPool();

    const severityResult = await auditPool.query<{
      severity: string;
      count: string;
    }>(
      `SELECT severity, COUNT(*)::text AS count
       FROM suspicious_activity_alerts
       WHERE created_at > NOW() - INTERVAL '24 hours'
       GROUP BY severity`,
    );

    const indicatorResult = await auditPool.query<{
      indicator: string;
      count: string;
    }>(
      `SELECT indicator, COUNT(*)::text AS count
       FROM suspicious_activity_alerts
       WHERE created_at > NOW() - INTERVAL '24 hours'
       GROUP BY indicator`,
    );

    let severe = 0;
    let warning = 0;
    for (const row of severityResult.rows) {
      if (row.severity === "severe") severe = Number(row.count);
      if (row.severity === "warning") warning = Number(row.count);
    }

    const byIndicator: Record<string, number> = {};
    for (const row of indicatorResult.rows) {
      byIndicator[row.indicator] = Number(row.count);
    }

    return Response.json({ severe, warning, byIndicator });
  },
  { ctx: "admin" },
);
