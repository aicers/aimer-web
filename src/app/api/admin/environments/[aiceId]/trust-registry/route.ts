import type { NextRequest } from "next/server";
import { assertAuthorized } from "@/lib/auth/authorization";
import { HttpError } from "@/lib/auth/errors";
import { verifyCsrf, verifyOrigin, withAuth } from "@/lib/auth/guards";
import {
  computeJwkThumbprint,
  InvalidJwkError,
} from "@/lib/auth/jwk-thumbprint";
import { getAuthPool } from "@/lib/db/client";

function extractAiceId(req: NextRequest): string | null {
  const parts = req.nextUrl.pathname.split("/");
  const idx = parts.indexOf("environments");
  return idx >= 0 ? parts[idx + 1] : null;
}

export const GET = withAuth(
  async (req: NextRequest, auth) => {
    const pool = getAuthPool();
    const client = await pool.connect();
    try {
      await assertAuthorized(
        client,
        "admin",
        auth.accountId,
        "trust-registry:read",
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

    const aiceId = extractAiceId(req);
    if (!aiceId) {
      return Response.json(
        { error: "Missing aiceId parameter" },
        { status: 400 },
      );
    }

    const result = await pool.query<{
      id: number;
      aice_id: string;
      issuer: string;
      kid: string;
      public_key: unknown;
      description: string | null;
      enabled: boolean;
      created_at: string;
      updated_at: string;
    }>(
      `SELECT id, aice_id, issuer, kid, public_key, description,
              enabled, created_at, updated_at
       FROM trust_registry
       WHERE aice_id = $1
       ORDER BY created_at`,
      [aiceId],
    );

    return Response.json({
      keys: result.rows.map((r) => ({
        id: r.id,
        aiceId: r.aice_id,
        issuer: r.issuer,
        kid: r.kid,
        publicKey: r.public_key,
        description: r.description,
        enabled: r.enabled,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      })),
    });
  },
  { ctx: "admin" },
);

export const POST = withAuth(
  async (req: NextRequest, auth) => {
    const originErr = verifyOrigin(req);
    if (originErr) return originErr;

    const csrfErr = verifyCsrf(req, {
      ctx: "admin",
      sid: auth.sessionId,
      iat: auth.iat,
    });
    if (csrfErr) return csrfErr;

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

    const aiceId = extractAiceId(req);
    if (!aiceId) {
      return Response.json(
        { error: "Missing aiceId parameter" },
        { status: 400 },
      );
    }

    // Verify environment exists
    const envCheck = await pool.query(
      `SELECT 1 FROM aice_environments WHERE aice_id = $1`,
      [aiceId],
    );
    if (envCheck.rows.length === 0) {
      return Response.json({ error: "Environment not found" }, { status: 404 });
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

    const { issuer, kid, publicKey, description } = raw as Record<
      string,
      unknown
    >;

    if (
      typeof issuer !== "string" ||
      typeof kid !== "string" ||
      !issuer.trim() ||
      !kid.trim()
    ) {
      return Response.json(
        { error: "issuer and kid are required non-empty strings" },
        { status: 400 },
      );
    }

    if (
      typeof publicKey !== "object" ||
      publicKey === null ||
      Array.isArray(publicKey)
    ) {
      return Response.json(
        { error: "publicKey must be a JWK object" },
        { status: 400 },
      );
    }

    if (description !== undefined && typeof description !== "string") {
      return Response.json(
        { error: "description must be a string" },
        { status: 400 },
      );
    }

    let thumbprint: string;
    try {
      const tp = await computeJwkThumbprint(publicKey);
      thumbprint = tp.base64url;
    } catch (err) {
      if (err instanceof InvalidJwkError) {
        return Response.json({ error: err.message }, { status: 400 });
      }
      throw err;
    }

    try {
      const result = await pool.query<{
        id: number;
        issuer: string;
        kid: string;
        enabled: boolean;
      }>(
        `INSERT INTO trust_registry (aice_id, issuer, kid, public_key, description)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, issuer, kid, enabled`,
        [
          aiceId,
          issuer.trim(),
          kid.trim(),
          JSON.stringify(publicKey),
          typeof description === "string" ? description : null,
        ],
      );

      const key = result.rows[0];

      auth.audit.targetId = String(key.id);
      auth.audit.details = {
        aiceId,
        issuer: key.issuer,
        kid: key.kid,
        jwkThumbprint: thumbprint,
      };

      return Response.json(
        {
          id: key.id,
          aiceId,
          issuer: key.issuer,
          kid: key.kid,
          enabled: key.enabled,
        },
        { status: 201 },
      );
    } catch (err: unknown) {
      const pgErr = err as { code?: string; constraint?: string };
      if (
        pgErr.code === "23505" &&
        pgErr.constraint === "trust_registry_aice_id_issuer_kid_key"
      ) {
        return Response.json(
          { error: "Key with this issuer and kid already exists" },
          { status: 409 },
        );
      }
      throw err;
    }
  },
  {
    ctx: "admin",
    audit: {
      action: "trust_registry.key_registered",
      targetType: "trust_registry",
    },
  },
);
