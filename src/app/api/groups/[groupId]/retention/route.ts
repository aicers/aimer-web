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
import {
  getGroupRetention,
  getGroupWithMembers,
  updateGroupRetention,
} from "@/lib/groups/groups";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const RETENTION_MIN_DAYS = 30;

/** `groupId` is the segment before `/retention`. */
function extractGroupId(req: NextRequest): string | null {
  const segments = req.nextUrl.pathname.split("/");
  const id = segments[segments.length - 2];
  if (!id || !UUID_RE.test(id)) return null;
  return id;
}

// GET /api/groups/[groupId]/retention — read the per-group policy.
// Auth: the all-member management predicate.
export const GET = withAuth(
  async (req: NextRequest, auth) => {
    // Management read is denied under a bridge — short-circuit before the
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

      const policy = await getGroupRetention(client, groupId);
      if (!policy) {
        return Response.json(
          { error: "Retention policy not found" },
          { status: 404 },
        );
      }
      return Response.json({ groupPolicyDays: policy.analysisDays });
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

function parseGroupPolicyDays(
  raw: unknown,
):
  | { ok: true; groupPolicyDays: number | null }
  | { ok: false; error: string; status: number } {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, error: "Invalid body", status: 400 };
  }
  const value = (raw as Record<string, unknown>).groupPolicyDays;
  if (value === null) {
    return { ok: true, groupPolicyDays: null };
  }
  if (typeof value !== "number" || !Number.isInteger(value)) {
    return { ok: false, error: "group_policy_days_required", status: 400 };
  }
  if (value < RETENTION_MIN_DAYS) {
    return { ok: false, error: "retention_too_short", status: 422 };
  }
  return { ok: true, groupPolicyDays: value };
}

// PUT /api/groups/[groupId]/retention — update the per-group policy.
// Auth: the all-member management predicate.
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
      // Authorize before parsing the body so a non-manager consistently
      // sees 403 rather than validation messages.
      await assertAllMemberManagement(client, auth.accountId, loaded.memberIds);

      let raw: unknown;
      try {
        raw = await req.json();
      } catch {
        return Response.json({ error: "Invalid JSON" }, { status: 400 });
      }
      const parsed = parseGroupPolicyDays(raw);
      if (!parsed.ok) {
        return Response.json(
          { error: parsed.error },
          { status: parsed.status },
        );
      }

      const result = await updateGroupRetention(
        client,
        groupId,
        parsed.groupPolicyDays,
        auth.accountId,
      );
      if (!result) {
        return Response.json(
          { error: "Retention policy not found" },
          { status: 404 },
        );
      }

      if (result.changed) {
        void auditLog({
          actorId: auth.accountId,
          authContext: "general",
          action: "group_retention_policy.updated",
          targetType: "group_retention_policy",
          targetId: groupId,
          ipAddress: auth.meta.ipAddress,
          sid: auth.sessionId,
          details: {
            before: { groupPolicyDays: result.before },
            after: { groupPolicyDays: result.after },
          },
        });
      }

      return Response.json({
        groupPolicyDays: result.after,
        changed: result.changed,
      });
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
