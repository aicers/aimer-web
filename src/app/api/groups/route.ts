import type { NextRequest } from "next/server";
import { auditLog } from "@/lib/audit";
import { validateCustomerFields } from "@/lib/auth/customers";
import { HttpError } from "@/lib/auth/errors";
import { listManageableGroups } from "@/lib/auth/group-authorization";
import {
  denyBridgeManagement,
  verifyCsrf,
  verifyOrigin,
  withAuth,
} from "@/lib/auth/guards";
import { DEFAULT_ANALYSIS_RETENTION_DAYS } from "@/lib/auth/retention-defaults";
import { getAuthPool, withTransaction } from "@/lib/db/client";
import { provisionGroupDb } from "@/lib/db/provision-group";
import { createGroup } from "@/lib/groups/groups";
import { validateGroupMembers } from "@/lib/groups/member-validation";

// GET /api/groups — list the groups the caller QUALIFIES TO MANAGE
// (Manager or eligible Analyst on EVERY member, per `assertAllMemberManagement`
// lifted to a list). This is the MANAGEMENT-scoped counterpart of #513's
// view-scoped `GET /api/auth/groups`: a stricter gate, and it carries owner /
// provisioning state the view list omits. The set-based `listManageableGroups`
// resolves access in one round trip rather than looping the predicate per group.
//
// Bridge sessions get `{ groups: [] }` — the same short-circuit the view list
// and the other group surfaces apply (a bridge holds no management grant), so
// the settings page is offered nothing under a bridge with no group-specific
// branch.
export const GET = withAuth(
  async (_req: NextRequest, auth) => {
    if (auth.bridgeCustomerIds !== null) {
      return Response.json({ groups: [] });
    }

    const groups = await withTransaction(getAuthPool(), (client) =>
      listManageableGroups(client, auth.accountId),
    );

    return Response.json({ groups });
  },
  { ctx: "general" },
);

// POST /api/groups — create a customer group.
//
// Auth: the all-member management predicate (Manager or Analyst on EVERY
// member). Body: { name, description?, memberIds: string[] (>=2 unique,
// <= GROUP_MAX_MEMBERS), tz? }. Requires every member to be operational;
// resolves the group tz (auto-adopt when members agree, else creator-chosen
// with a deterministic recommendation). Sets owner_id = created_by = creator.
//
// The member/tz/gate/operational front-door checks are shared with
// `POST /api/groups/preview` via `validateGroupMembers` (capMode "reject":
// over-cap → 400 too_many_members, tz divergence → 400 { recommendedTz }).
// Create layers the write path (createGroup, audit, provisioning) on top.
export const POST = withAuth(
  async (req: NextRequest, auth) => {
    const originErr = verifyOrigin(req);
    if (originErr) return originErr;

    const csrfErr = verifyCsrf(req, {
      ctx: "general",
      sid: auth.sessionId,
      iat: auth.iat,
    });
    if (csrfErr) return csrfErr;

    // Management create is denied under a bridge — short-circuit before
    // `validateGroupMembers` reaches the account's real management grants.
    const bridgeErr = denyBridgeManagement(auth.bridgeCustomerIds);
    if (bridgeErr) return bridgeErr;

    let raw: unknown;
    try {
      raw = await req.json();
    } catch {
      return Response.json({ error: "Invalid JSON" }, { status: 400 });
    }
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      return Response.json({ error: "Invalid body" }, { status: 400 });
    }
    const body = raw as Record<string, unknown>;

    // name (required) + description (optional). Reuse the customer field
    // validator (trim, control-char and length checks).
    let name: string;
    let description: string | null;
    try {
      const fields = validateCustomerFields({
        name: body.name,
        description: body.description,
      });
      if (fields.name === undefined) {
        return Response.json({ error: "name_required" }, { status: 400 });
      }
      name = fields.name;
      description = fields.description ?? null;
    } catch (err) {
      if (err instanceof HttpError) {
        return Response.json(
          { error: err.message },
          { status: err.statusCode },
        );
      }
      throw err;
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
      // Shared front-door validation: memberIds parse, UUID/duplicate/min/max,
      // tz, all-member management gate (throws HttpError 403), operational
      // check, and tz resolution. "reject" mode 400s an over-cap member count
      // (too_many_members) and tz divergence ({ recommendedTz }).
      const validation = await validateGroupMembers(
        client,
        auth.accountId,
        body,
        "reject",
      );
      if (!validation.ok) return validation.response;
      const { memberIds, tz } = validation.value;
      if (tz === null) {
        // Unreachable in "reject" mode (tz divergence already 400'd above);
        // narrows the type without a non-null assertion.
        throw new Error("group tz unresolved in reject mode");
      }

      // Write the group, membership, and retention policy atomically.
      let created: Awaited<ReturnType<typeof createGroup>>;
      try {
        await client.query("BEGIN");
        created = await createGroup(client, {
          name,
          description,
          memberIds,
          tz,
          creatorAccountId: auth.accountId,
          analysisDays: DEFAULT_ANALYSIS_RETENTION_DAYS,
        });
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        throw err;
      }

      // Awaited (not fire-and-forget) so the PII-bearing create row —
      // details.name and details.memberIds — is committed BEFORE the 201
      // returns, establishing a happens-before edge over any subsequent
      // delete. teardownGroupDb()'s anonymizeGroupAuditLogs() scrubs by
      // `WHERE target_id = $1` at a point in time; a `void auditLog(...)`
      // here races that scrub: if the client deletes the just-created group
      // and the floating insert lands after anonymization, the create row
      // survives with the raw group name and membership list intact,
      // defeating the crypto-shred (the same class of race the delete row
      // fix closed). auditLog() still swallows audit-DB errors, so awaiting
      // keeps the write best-effort while denying a late raw row an escape.
      await auditLog({
        actorId: auth.accountId,
        authContext: "general",
        action: "customer_group.created",
        targetType: "customer_group",
        targetId: created.id,
        ipAddress: auth.meta.ipAddress,
        sid: auth.sessionId,
        details: { name: created.name, memberIds: created.memberIds, tz },
      });

      // Release the auth-pool client BEFORE the slow provisioning phase.
      // provisionGroupDb() reads/updates customer_groups via the same auth
      // pool, so holding this idle client across that work risks
      // self-starvation under pool saturation (every concurrent create
      // pins one client, then all wait for another to store the DEK / flip
      // status). The customer create path likewise exits its
      // transaction/client scope before provisioning. releaseClient() is
      // idempotent — the finally below is a no-op once we have released.
      releaseClient();

      // Provision the group's dedicated data DB after the auth-DB
      // transaction commits, and AWAIT it before responding (mirroring the
      // customer create path — not fire-and-forget). The 201 body carries
      // the resulting databaseStatus so the client sees active/failed
      // without a second round-trip.
      const databaseStatus = await provisionGroupDb(pool, created.id, {
        actorContext: {
          actorId: auth.accountId,
          authContext: "general",
          ipAddress: auth.meta.ipAddress,
          sid: auth.sessionId,
        },
      });

      return Response.json(
        {
          id: created.id,
          name: created.name,
          description: created.description,
          ownerId: created.ownerId,
          createdBy: created.createdBy,
          createdAt: created.createdAt,
          tz: created.tz,
          memberIds: created.memberIds,
          databaseStatus,
        },
        { status: 201 },
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
      releaseClient();
    }
  },
  { ctx: "general" },
);
