import type { NextRequest } from "next/server";
import { auditLog } from "@/lib/audit";
import { HttpError } from "@/lib/auth/errors";
import { assertAllMemberManagement } from "@/lib/auth/group-authorization";
import { verifyCsrf, verifyOrigin, withAuth } from "@/lib/auth/guards";
import { getAuthPool, getMigrationAuditPool } from "@/lib/db/client";
import { teardownGroupDb } from "@/lib/db/teardown-group";
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
    let released = false;
    const releaseClient = () => {
      if (!released) {
        released = true;
        client.release();
      }
    };
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

      // Release the auth-pool client BEFORE the slow teardown phase. The
      // DROP DATABASE / anonymize / Transit-destroy sequence is post-commit
      // infra work that does not need the auth client; holding it across
      // teardown can exhaust auth-pool connections under load. The customer
      // delete path likewise releases before its Phase 2. releaseClient()
      // is idempotent — the finally below is a no-op once we have released.
      releaseClient();

      // Tear down the group's dedicated data DB AFTER the auth-DB delete
      // commits, as a best-effort post-commit step (mirroring
      // delete-customer Phase 2, same order: terminate connections → DROP
      // DATABASE → anonymize audit logs → destroy Transit key). A teardown
      // failure is swallowed internally and never blocks the entity delete
      // — the group's auth-DB rows are already gone via ON DELETE CASCADE.
      await teardownGroupDb(getMigrationAuditPool(), groupId, {
        actorId: auth.accountId,
        authContext: "general",
        ipAddress: auth.meta.ipAddress,
        sid: auth.sessionId,
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
      releaseClient();
    }
  },
  { ctx: "general" },
);
