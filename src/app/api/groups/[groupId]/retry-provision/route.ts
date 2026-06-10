import type { NextRequest } from "next/server";
import { HttpError } from "@/lib/auth/errors";
import { assertGroupOwner } from "@/lib/auth/group-authorization";
import {
  denyBridgeManagement,
  verifyCsrf,
  verifyOrigin,
  withAuth,
} from "@/lib/auth/guards";
import { getAuthPool } from "@/lib/db/client";
import { provisionGroupDb } from "@/lib/db/provision-group";
import { getGroupWithMembers } from "@/lib/groups/groups";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// POST /api/groups/[groupId]/retry-provision — re-run provisioning for a
// group whose data DB is in `failed` state. The operator recovery trigger
// peer of the customer `retry-provision` endpoint. Auth: owner-only (#510
// narrows the interim all-member management gate).
//
// provisionGroupDb is idempotent / retry-safe: CREATE DATABASE and the DEK
// generation skip when already present, and migrations resume from the
// last applied version. Only allowed when database_status is 'failed'.
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

    // Owner-only retry is denied under a bridge — short-circuit before the
    // owner gate consults the account's real owner identity.
    const bridgeErr = denyBridgeManagement(auth.bridgeCustomerIds);
    if (bridgeErr) return bridgeErr;

    const segments = req.nextUrl.pathname.split("/");
    const groupId = segments[segments.length - 2];
    if (!groupId || !UUID_RE.test(groupId)) {
      return Response.json({ error: "Invalid group ID" }, { status: 400 });
    }

    const pool = getAuthPool();
    const client = await pool.connect();
    try {
      const loaded = await getGroupWithMembers(client, groupId);
      if (!loaded) {
        return Response.json({ error: "Group not found" }, { status: 404 });
      }

      // Owner-only (#510 narrows the interim all-member management gate).
      assertGroupOwner(loaded.group.ownerId, auth.accountId);

      const { rows } = await client.query<{ database_status: string }>(
        "SELECT database_status FROM customer_groups WHERE id = $1",
        [groupId],
      );
      if (rows.length === 0) {
        return Response.json({ error: "Group not found" }, { status: 404 });
      }
      if (rows[0].database_status !== "failed") {
        return Response.json(
          { error: "Retry is only allowed when database_status is 'failed'" },
          { status: 409 },
        );
      }

      await client.query(
        "UPDATE customer_groups SET database_status = 'provisioning' WHERE id = $1",
        [groupId],
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

    const databaseStatus = await provisionGroupDb(pool, groupId, {
      isRetry: true,
      actorContext: {
        actorId: auth.accountId,
        authContext: "general",
        ipAddress: auth.meta.ipAddress,
        sid: auth.sessionId,
      },
    });

    return Response.json({ databaseStatus });
  },
  { ctx: "general" },
);
