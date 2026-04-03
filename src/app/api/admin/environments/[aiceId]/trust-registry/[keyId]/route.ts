import type { NextRequest } from "next/server";
import { assertAuthorized } from "@/lib/auth/authorization";
import { HttpError } from "@/lib/auth/errors";
import { verifyCsrf, verifyOrigin, withAuth } from "@/lib/auth/guards";
import { getAuthPool } from "@/lib/db/client";

function extractIds(req: NextRequest): {
  aiceId: string | null;
  keyId: string | null;
} {
  // /api/admin/environments/[aiceId]/trust-registry/[keyId]
  const parts = req.nextUrl.pathname.split("/");
  const envIdx = parts.indexOf("environments");
  const trIdx = parts.indexOf("trust-registry");
  return {
    aiceId: envIdx >= 0 ? parts[envIdx + 1] : null,
    keyId: trIdx >= 0 ? parts[trIdx + 1] : null,
  };
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

    const { aiceId, keyId } = extractIds(req);
    if (!aiceId || !keyId || !/^\d+$/.test(keyId)) {
      return Response.json({ error: "Invalid parameters" }, { status: 400 });
    }

    const pool = getAuthPool();
    const authzClient = await pool.connect();
    try {
      await assertAuthorized(
        authzClient,
        "admin",
        auth.accountId,
        "trust-registry:write",
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

    if (body.enabled !== undefined && typeof body.enabled !== "boolean") {
      return Response.json(
        { error: "enabled must be a boolean" },
        { status: 400 },
      );
    }

    if (
      body.description !== undefined &&
      body.description !== null &&
      typeof body.description !== "string"
    ) {
      return Response.json(
        { error: "description must be a string or null" },
        { status: 400 },
      );
    }

    const sets: string[] = [];
    const values: unknown[] = [];
    let idx = 1;

    if (body.enabled !== undefined) {
      sets.push(`enabled = $${idx++}`);
      values.push(body.enabled);
    }

    if (body.description !== undefined) {
      sets.push(`description = $${idx++}`);
      values.push(body.description);
    }

    if (sets.length === 0) {
      return Response.json({ error: "No fields to update" }, { status: 400 });
    }

    sets.push(`updated_at = NOW()`);
    values.push(Number(keyId), aiceId);

    const result = await pool.query<{
      id: number;
      enabled: boolean;
      description: string | null;
    }>(
      `UPDATE trust_registry SET ${sets.join(", ")}
       WHERE id = $${idx} AND aice_id = $${idx + 1}
       RETURNING id, enabled, description`,
      values,
    );

    if (result.rows.length === 0) {
      return Response.json({ error: "Key not found" }, { status: 404 });
    }

    const key = result.rows[0];

    auth.audit.targetId = String(key.id);
    auth.audit.details = {
      aiceId,
      keyId: key.id,
      enabled: key.enabled,
    };

    return Response.json({
      id: key.id,
      enabled: key.enabled,
      description: key.description,
    });
  },
  {
    ctx: "admin",
    audit: {
      action: "trust_registry.key_disabled",
      targetType: "trust_registry",
    },
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

    const { aiceId, keyId } = extractIds(req);
    if (!aiceId || !keyId || !/^\d+$/.test(keyId)) {
      return Response.json({ error: "Invalid parameters" }, { status: 400 });
    }

    const pool = getAuthPool();
    const authzClient = await pool.connect();
    try {
      await assertAuthorized(
        authzClient,
        "admin",
        auth.accountId,
        "trust-registry:write",
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

    const result = await pool.query(
      `DELETE FROM trust_registry
       WHERE id = $1 AND aice_id = $2
       RETURNING id`,
      [Number(keyId), aiceId],
    );

    if (result.rows.length === 0) {
      return Response.json({ error: "Key not found" }, { status: 404 });
    }

    auth.audit.targetId = keyId;
    auth.audit.details = { aiceId, keyId: Number(keyId) };

    return new Response(null, { status: 204 });
  },
  {
    ctx: "admin",
    audit: {
      action: "trust_registry.key_removed",
      targetType: "trust_registry",
    },
  },
);
