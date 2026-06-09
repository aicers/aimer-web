import type { NextRequest } from "next/server";
import { auditLog } from "@/lib/audit";
import { HttpError } from "@/lib/auth/errors";
import { assertAllMemberManagement } from "@/lib/auth/group-authorization";
import { verifyCsrf, verifyOrigin, withAuth } from "@/lib/auth/guards";
import { getAuthPool } from "@/lib/db/client";
import { deleteGroup, getGroupWithMembers } from "@/lib/groups/groups";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `groupId` is the last path segment of `/api/groups/[groupId]`. */
function extractGroupId(req: NextRequest): string | null {
  const segments = req.nextUrl.pathname.split("/");
  const id = segments[segments.length - 1];
  if (!id || !UUID_RE.test(id)) return null;
  return id;
}

// DELETE /api/groups/[groupId] — entity-level delete.
//
// Auth (interim): the all-member management predicate (#510 later narrows
// to owner-only). Removes the group / member / subject rows and the
// group's auth-DB retention-policy row via ON DELETE CASCADE from the
// subject row — no orphan policy survives.
export const DELETE = withAuth(
  async (req: NextRequest, auth) => {
    const originErr = verifyOrigin(req);
    if (originErr) return originErr;

    const csrfErr = verifyCsrf(req, {
      ctx: "general",
      sid: auth.sessionId,
      iat: auth.iat,
    });
    if (csrfErr) return csrfErr;

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

      const deleted = await deleteGroup(client, groupId);
      if (!deleted) {
        // Lost a race with a concurrent delete — treat as not found.
        return Response.json({ error: "Group not found" }, { status: 404 });
      }

      void auditLog({
        actorId: auth.accountId,
        authContext: "general",
        action: "customer_group.deleted",
        targetType: "customer_group",
        targetId: groupId,
        ipAddress: auth.meta.ipAddress,
        sid: auth.sessionId,
        details: { memberIds: loaded.memberIds },
      });

      return new Response(null, { status: 204 });
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
