import type { NextRequest } from "next/server";
import { purgeExpiredAuditLogs } from "@/lib/audit/retention";
import { verifyCsrf, verifyOrigin, withAuth } from "@/lib/auth/guards";
import { getMigrationAuditPool } from "@/lib/db/client";

export const POST = withAuth(
  async (req: NextRequest, auth) => {
    const originErr = verifyOrigin(req);
    if (originErr) return originErr;

    const csrfErr = verifyCsrf(req, {
      ctx: "admin",
      sid: auth.sessionId,
      iat: auth.iat,
    });
    if (csrfErr) return csrfErr;

    let retentionDays: number | undefined;
    try {
      const body = await req.json();
      if (
        typeof body === "object" &&
        body !== null &&
        "retentionDays" in body
      ) {
        const val = body.retentionDays;
        if (typeof val !== "number" || !Number.isInteger(val) || val < 1) {
          return Response.json(
            { error: "retentionDays must be a positive integer" },
            { status: 400 },
          );
        }
        retentionDays = val;
      }
    } catch {
      return Response.json({ error: "Invalid JSON" }, { status: 400 });
    }

    const deleted = await purgeExpiredAuditLogs(
      getMigrationAuditPool(),
      retentionDays,
    );

    auth.audit.details = { retentionDays: retentionDays ?? 365, deleted };

    return Response.json({ deleted });
  },
  {
    ctx: "admin",
    audit: { action: "system.settings_updated", targetType: "audit-retention" },
  },
);
