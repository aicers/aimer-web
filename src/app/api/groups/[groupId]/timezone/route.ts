import type { NextRequest } from "next/server";
import { auditLog } from "@/lib/audit";
import { HttpError } from "@/lib/auth/errors";
import { assertAllMemberManagement } from "@/lib/auth/group-authorization";
import {
  denyBridgeManagement,
  verifyCsrf,
  verifyOrigin,
  withAuth,
} from "@/lib/auth/guards";
import { getAuthPool } from "@/lib/db/client";
import { getGroupWithMembers, updateGroupTimezone } from "@/lib/groups/groups";
import { isValidTimeZone } from "@/lib/groups/timezone";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `groupId` is the segment before `/timezone`. */
function extractGroupId(req: NextRequest): string | null {
  const segments = req.nextUrl.pathname.split("/");
  const id = segments[segments.length - 2];
  if (!id || !UUID_RE.test(id)) return null;
  return id;
}

// PUT /api/groups/[groupId]/timezone — re-set the group bucket tz.
// Auth: the all-member management predicate. Re-setting affects only
// FUTURE buckets; past `periodic_report_state` rows keep their tz key.
export const PUT = withAuth(
  async (req: NextRequest, auth) => {
    const originErr = verifyOrigin(req);
    if (originErr) return originErr;

    const csrfErr = verifyCsrf(req, {
      ctx: "general",
      sid: auth.sessionId,
      iat: auth.iat,
    });
    if (csrfErr) return csrfErr;

    // Management write is denied under a bridge — short-circuit before the
    // all-member predicate consults the account's real management grants.
    const bridgeErr = denyBridgeManagement(auth.bridgeCustomerIds);
    if (bridgeErr) return bridgeErr;

    const groupId = extractGroupId(req);
    if (!groupId) {
      return Response.json({ error: "Invalid group ID" }, { status: 400 });
    }

    const pool = getAuthPool();
    const client = await pool.connect();
    try {
      const loaded = await getGroupWithMembers(client, groupId);
      if (!loaded) {
        return Response.json({ error: "Group not found" }, { status: 404 });
      }
      await assertAllMemberManagement(client, auth.accountId, loaded.memberIds);

      let raw: unknown;
      try {
        raw = await req.json();
      } catch {
        return Response.json({ error: "Invalid JSON" }, { status: 400 });
      }
      if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
        return Response.json({ error: "Invalid body" }, { status: 400 });
      }
      const tz = (raw as Record<string, unknown>).tz;
      if (typeof tz !== "string" || !isValidTimeZone(tz)) {
        return Response.json({ error: "invalid_timezone" }, { status: 400 });
      }

      const result = await updateGroupTimezone(client, groupId, tz);
      if (!result) {
        return Response.json({ error: "Group not found" }, { status: 404 });
      }

      if (result.changed) {
        void auditLog({
          actorId: auth.accountId,
          authContext: "general",
          action: "customer_group.timezone_updated",
          targetType: "customer_group",
          targetId: groupId,
          ipAddress: auth.meta.ipAddress,
          sid: auth.sessionId,
          details: { before: result.before, after: result.after },
        });
      }

      return Response.json({ tz: result.after, changed: result.changed });
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
  },
  { ctx: "general" },
);
