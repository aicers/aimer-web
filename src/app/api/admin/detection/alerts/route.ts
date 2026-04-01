import type { NextRequest } from "next/server";
import { assertAuthorized } from "@/lib/auth/authorization";
import { HttpError } from "@/lib/auth/errors";
import { withAuth } from "@/lib/auth/guards";
import { getAuditPool, getAuthPool } from "@/lib/db/client";
import { ALL_INDICATORS } from "@/lib/detection/indicators";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

const VALID_SEVERITIES = new Set(["severe", "warning"]);
const VALID_INDICATORS: Set<string> = new Set(ALL_INDICATORS);

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

    const params = req.nextUrl.searchParams;

    // Pagination
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

    // Filters
    const severity = params.get("severity");
    if (severity && !VALID_SEVERITIES.has(severity)) {
      return Response.json(
        { error: "severity must be 'severe' or 'warning'" },
        { status: 400 },
      );
    }

    const indicator = params.get("indicator");
    if (indicator && !VALID_INDICATORS.has(indicator)) {
      return Response.json(
        { error: "Invalid indicator value" },
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
    if (severity) {
      conditions.push(`severity = $${idx++}`);
      values.push(severity);
    }
    if (indicator) {
      conditions.push(`indicator = $${idx++}`);
      values.push(indicator);
    }
    if (from) {
      conditions.push(`created_at >= $${idx++}::timestamptz`);
      values.push(from);
    }
    if (to) {
      conditions.push(`created_at <= $${idx++}::timestamptz`);
      values.push(to);
    }

    const where =
      conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    values.push(limit + 1);

    const sql = `
      SELECT id, created_at, indicator, severity, actor_id, ip_address,
             summary, audit_log_ids, correlation_id
      FROM suspicious_activity_alerts
      ${where}
      ORDER BY id DESC
      LIMIT $${idx}`;

    const auditPool = getAuditPool();
    const result = await auditPool.query(sql, values);

    const hasMore = result.rows.length > limit;
    const rows = hasMore ? result.rows.slice(0, limit) : result.rows;
    const nextCursor = hasMore ? String(rows[rows.length - 1].id) : null;

    return Response.json({
      data: rows.map((r) => ({
        id: String(r.id),
        createdAt: r.created_at,
        indicator: r.indicator,
        severity: r.severity,
        actorId: r.actor_id,
        ipAddress: r.ip_address,
        summary: r.summary,
        auditLogIds: r.audit_log_ids,
        correlationId: r.correlation_id,
      })),
      nextCursor,
    });
  },
  { ctx: "admin" },
);
