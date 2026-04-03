import type { NextRequest } from "next/server";
import { assertAuthorized } from "@/lib/auth/authorization";
import { HttpError } from "@/lib/auth/errors";
import { verifyCsrf, verifyOrigin, withAuth } from "@/lib/auth/guards";
import { getAuthPool, withTransaction } from "@/lib/db/client";

function extractAiceId(req: NextRequest): string | null {
  const parts = req.nextUrl.pathname.split("/");
  // /api/admin/environments/[aiceId]
  return parts[parts.length - 1] || null;
}

export const PATCH = withAuth(
  async (req: NextRequest, auth) => {
    const originErr = verifyOrigin(req);
    if (originErr) return originErr;

    const csrfErr = verifyCsrf(req, {
      ctx: "admin",
      sid: auth.sessionId,
      iat: auth.iat,
    });
    if (csrfErr) return csrfErr;

    const aiceId = extractAiceId(req);
    if (!aiceId) {
      return Response.json(
        { error: "Missing aiceId parameter" },
        { status: 400 },
      );
    }

    const pool = getAuthPool();
    const authzClient = await pool.connect();
    try {
      await assertAuthorized(
        authzClient,
        "admin",
        auth.accountId,
        "aice-environments:write",
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
      authzClient.release();
    }

    let raw: unknown;
    try {
      raw = await req.json();
    } catch {
      return Response.json({ error: "Invalid JSON" }, { status: 400 });
    }

    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      return Response.json(
        { error: "Request body must be a JSON object" },
        { status: 400 },
      );
    }

    const body = raw as Record<string, unknown>;

    const sets: string[] = [];
    const values: unknown[] = [];
    let idx = 1;

    if (body.name !== undefined) {
      if (typeof body.name !== "string" || !body.name.trim()) {
        return Response.json(
          { error: "name must be a non-empty string" },
          { status: 400 },
        );
      }
      sets.push(`name = $${idx++}`);
      values.push(body.name.trim());
    }

    if (body.description !== undefined) {
      if (body.description !== null && typeof body.description !== "string") {
        return Response.json(
          { error: "description must be a string or null" },
          { status: 400 },
        );
      }
      sets.push(`description = $${idx++}`);
      values.push(body.description);
    }

    if (body.status !== undefined) {
      if (
        body.status !== "active" &&
        body.status !== "suspended" &&
        body.status !== "disabled"
      ) {
        return Response.json(
          { error: "status must be active, suspended, or disabled" },
          { status: 400 },
        );
      }
      sets.push(`status = $${idx++}`);
      values.push(body.status);
    }

    if (sets.length === 0) {
      return Response.json({ error: "No fields to update" }, { status: 400 });
    }

    sets.push(`updated_at = NOW()`);
    values.push(aiceId);

    const result = await pool.query<{
      id: number;
      aice_id: string;
      name: string;
      description: string | null;
      status: string;
      updated_at: string;
    }>(
      `UPDATE aice_environments SET ${sets.join(", ")}
       WHERE aice_id = $${idx}
       RETURNING id, aice_id, name, description, status, updated_at`,
      values,
    );

    if (result.rows.length === 0) {
      return Response.json({ error: "Environment not found" }, { status: 404 });
    }

    const env = result.rows[0];

    auth.audit.targetId = env.aice_id;
    auth.audit.details = {
      aiceId: env.aice_id,
      updated: Object.keys(body).filter((k) => body[k] !== undefined),
    };

    return Response.json({
      id: env.id,
      aiceId: env.aice_id,
      name: env.name,
      description: env.description,
      status: env.status,
      updatedAt: env.updated_at,
    });
  },
  {
    ctx: "admin",
    audit: { action: "environment.updated", targetType: "environment" },
  },
);

export const DELETE = withAuth(
  async (req: NextRequest, auth) => {
    const originErr = verifyOrigin(req);
    if (originErr) return originErr;

    const csrfErr = verifyCsrf(req, {
      ctx: "admin",
      sid: auth.sessionId,
      iat: auth.iat,
    });
    if (csrfErr) return csrfErr;

    const aiceId = extractAiceId(req);
    if (!aiceId) {
      return Response.json(
        { error: "Missing aiceId parameter" },
        { status: 400 },
      );
    }

    const pool = getAuthPool();
    const authzClient = await pool.connect();
    try {
      await assertAuthorized(
        authzClient,
        "admin",
        auth.accountId,
        "aice-environments:write",
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
      authzClient.release();
    }

    const result = await withTransaction(pool, async (client) => {
      // Delete trust registry keys first (FK constraint)
      await client.query(`DELETE FROM trust_registry WHERE aice_id = $1`, [
        aiceId,
      ]);

      // aice_environment_customers will cascade via ON DELETE CASCADE
      const delResult = await client.query(
        `DELETE FROM aice_environments WHERE aice_id = $1 RETURNING aice_id`,
        [aiceId],
      );

      return delResult.rows.length > 0;
    });

    if (!result) {
      return Response.json({ error: "Environment not found" }, { status: 404 });
    }

    auth.audit.targetId = aiceId;

    return new Response(null, { status: 204 });
  },
  {
    ctx: "admin",
    audit: { action: "environment.deleted", targetType: "environment" },
  },
);
