import type { NextRequest } from "next/server";
import { auditLog } from "@/lib/audit";
import { validateCustomerFields } from "@/lib/auth/customers";
import { HttpError } from "@/lib/auth/errors";
import { assertAllMemberManagement } from "@/lib/auth/group-authorization";
import { verifyCsrf, verifyOrigin, withAuth } from "@/lib/auth/guards";
import { DEFAULT_ANALYSIS_RETENTION_DAYS } from "@/lib/auth/retention-defaults";
import { getAuthPool } from "@/lib/db/client";
import { provisionGroupDb } from "@/lib/db/provision-group";
import { createGroup, fetchMemberStates } from "@/lib/groups/groups";
import { isValidTimeZone, resolveGroupTimezone } from "@/lib/groups/timezone";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// POST /api/groups — create a customer group.
//
// Auth: the all-member management predicate (Manager or Analyst on EVERY
// member). Body: { name, description?, memberIds: string[] (>=2 unique),
// tz? }. Requires every member to be operational; resolves the group tz
// (auto-adopt when members agree, else creator-chosen with a deterministic
// recommendation). Sets owner_id = created_by = creator.
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

    // memberIds: array of UUID strings, >= 2 DISTINCT, duplicates rejected.
    const memberIdsRaw = body.memberIds;
    if (
      !Array.isArray(memberIdsRaw) ||
      !memberIdsRaw.every((x) => typeof x === "string")
    ) {
      return Response.json({ error: "memberIds_required" }, { status: 400 });
    }
    const memberIds = memberIdsRaw as string[];
    if (!memberIds.every((id) => UUID_RE.test(id))) {
      return Response.json({ error: "invalid_member_id" }, { status: 400 });
    }
    if (new Set(memberIds).size !== memberIds.length) {
      // Duplicate ids must not satisfy the >= 2 check by repetition.
      return Response.json({ error: "duplicate_members" }, { status: 400 });
    }
    if (memberIds.length < 2) {
      return Response.json({ error: "too_few_members" }, { status: 400 });
    }

    // tz: validate IANA when supplied; otherwise resolved from members.
    const tzRaw = body.tz;
    let chosenTz: string | null = null;
    if (tzRaw !== undefined && tzRaw !== null) {
      if (typeof tzRaw !== "string" || !isValidTimeZone(tzRaw)) {
        return Response.json({ error: "invalid_timezone" }, { status: 400 });
      }
      chosenTz = tzRaw;
    }

    const pool = getAuthPool();
    const client = await pool.connect();
    try {
      // Binding gate: Manager/Analyst on every member. A non-existent
      // member yields no grant and is rejected here as 403 (no existence
      // leak), so eligibility below only sees real customers.
      await assertAllMemberManagement(client, auth.accountId, memberIds);

      // Every member must exist and be operational
      // (status='active' AND database_status='active').
      const states = await fetchMemberStates(client, memberIds);
      const stateById = new Map(states.map((s) => [s.id, s]));
      for (const id of memberIds) {
        const s = stateById.get(id);
        if (!s) {
          return Response.json({ error: "member_not_found" }, { status: 400 });
        }
        if (s.status !== "active" || s.databaseStatus !== "active") {
          return Response.json(
            { error: "member_not_operational" },
            { status: 422 },
          );
        }
      }

      // Resolve the bucket tz. When members differ and no tz was chosen,
      // return 400 { recommendedTz } so the client can prompt + resubmit.
      const memberTzs = memberIds.map(
        (id) => stateById.get(id)?.timezone ?? "UTC",
      );
      const resolution = resolveGroupTimezone(memberTzs, chosenTz);
      if (!resolution.ok) {
        return Response.json(
          { recommendedTz: resolution.recommendedTz },
          { status: 400 },
        );
      }
      const tz = resolution.tz;

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

      void auditLog({
        actorId: auth.accountId,
        authContext: "general",
        action: "customer_group.created",
        targetType: "customer_group",
        targetId: created.id,
        ipAddress: auth.meta.ipAddress,
        sid: auth.sessionId,
        details: { name: created.name, memberIds: created.memberIds, tz },
      });

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
      client.release();
    }
  },
  { ctx: "general" },
);
