import type { NextRequest } from "next/server";
import { assertAuthorized } from "@/lib/auth/authorization";
import { HttpError } from "@/lib/auth/errors";
import { withAuth } from "@/lib/auth/guards";
import { getAuditPool, getAuthPool } from "@/lib/db/client";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const VALID_AUTH_CONTEXTS = new Set(["general", "admin"]);

export const GET = withAuth(
  async (req: NextRequest, auth) => {
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

    const url = req.nextUrl;
    const params = url.searchParams;

    // Parse pagination
    const cursorParam = params.get("cursor");
    const cursor = cursorParam ? Number(cursorParam) : null;
    if (cursor !== null && (!Number.isFinite(cursor) || cursor < 0)) {
      return Response.json({ error: "Invalid cursor" }, { status: 400 });
    }

    const limitParam = params.get("limit");
    let limit = DEFAULT_LIMIT;
    if (limitParam) {
      limit = Number(limitParam);
      if (!Number.isFinite(limit) || limit < 1 || limit > MAX_LIMIT) {
        return Response.json(
          { error: `limit must be between 1 and ${MAX_LIMIT}` },
          { status: 400 },
        );
      }
    }

    // Parse filters
    const authContext = params.get("auth_context");
    if (authContext && !VALID_AUTH_CONTEXTS.has(authContext)) {
      return Response.json(
        { error: "auth_context must be 'general' or 'admin'" },
        { status: 400 },
      );
    }

    const action = params.get("action");
    const actorId = params.get("actor_id");
    const customerId = params.get("customer_id");
    if (customerId && !UUID_RE.test(customerId)) {
      return Response.json(
        { error: "Invalid customer_id format" },
        { status: 400 },
      );
    }

    const aiceId = params.get("aice_id");
    const correlationId = params.get("correlation_id");
    if (correlationId && !UUID_RE.test(correlationId)) {
      return Response.json(
        { error: "Invalid correlation_id format" },
        { status: 400 },
      );
    }

    const from = params.get("from");
    const to = params.get("to");
    if (from && Number.isNaN(Date.parse(from))) {
      return Response.json({ error: "Invalid from date" }, { status: 400 });
    }
    if (to && Number.isNaN(Date.parse(to))) {
      return Response.json({ error: "Invalid to date" }, { status: 400 });
    }

    // Build query
    const conditions: string[] = [];
    const values: unknown[] = [];
    let idx = 1;

    if (cursor !== null) {
      conditions.push(`id < $${idx++}`);
      values.push(cursor);
    }
    if (authContext) {
      conditions.push(`auth_context = $${idx++}`);
      values.push(authContext);
    }
    if (action) {
      conditions.push(`action = $${idx++}`);
      values.push(action);
    }
    if (actorId) {
      conditions.push(`actor_id = $${idx++}`);
      values.push(actorId);
    }
    if (customerId) {
      conditions.push(`customer_id = $${idx++}::uuid`);
      values.push(customerId);
    }
    if (aiceId) {
      conditions.push(`aice_id = $${idx++}`);
      values.push(aiceId);
    }
    if (correlationId) {
      conditions.push(`correlation_id = $${idx++}::uuid`);
      values.push(correlationId);
    }
    if (from) {
      conditions.push(`timestamp >= $${idx++}::timestamptz`);
      values.push(from);
    }
    if (to) {
      conditions.push(`timestamp <= $${idx++}::timestamptz`);
      values.push(to);
    }

    const where =
      conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    // Fetch limit+1 to determine if there is a next page
    values.push(limit + 1);

    const sql = `
      SELECT id, timestamp, actor_id, auth_context, action, target_type,
             target_id, details, ip_address, sid, customer_id, aice_id,
             correlation_id
      FROM audit_logs
      ${where}
      ORDER BY id DESC
      LIMIT $${idx}`;

    try {
      const auditPool = getAuditPool();
      const result = await auditPool.query(sql, values);

      const hasMore = result.rows.length > limit;
      const rows = hasMore ? result.rows.slice(0, limit) : result.rows;

      const nextCursor = hasMore ? String(rows[rows.length - 1].id) : null;

      return Response.json({
        data: rows.map((r) => ({
          id: String(r.id),
          timestamp: r.timestamp,
          actorId: r.actor_id,
          authContext: r.auth_context,
          action: r.action,
          targetType: r.target_type,
          targetId: r.target_id,
          details: r.details,
          ipAddress: r.ip_address,
          sid: r.sid,
          customerId: r.customer_id,
          aiceId: r.aice_id,
          correlationId: r.correlation_id,
        })),
        nextCursor,
      });
    } catch (err) {
      if (err instanceof HttpError) {
        return Response.json(
          { error: err.message },
          { status: err.statusCode },
        );
      }
      throw err;
    }
  },
  { ctx: "admin" },
);
