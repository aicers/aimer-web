import type { NextRequest } from "next/server";
import { auditLog } from "@/lib/audit";
import { assertAuthorized } from "@/lib/auth/authorization";
import { HttpError } from "@/lib/auth/errors";
import { parseExpiresAtInput } from "@/lib/auth/expires-at";
import { verifyCsrf, verifyOrigin, withAuth } from "@/lib/auth/guards";
import {
  computeJwkThumbprint,
  InvalidJwkError,
} from "@/lib/auth/jwk-thumbprint";
import { invalidateTrustRegistryCache } from "@/lib/auth/trust-registry";
import { getAuthPool, withTransaction } from "@/lib/db/client";

export const GET = withAuth(
  async (_req, auth) => {
    const pool = getAuthPool();
    const client = await pool.connect();
    try {
      await assertAuthorized(
        client,
        "admin",
        auth.accountId,
        "aice-environments:read",
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

    const result = await pool.query<{
      id: number;
      aice_id: string;
      name: string;
      description: string | null;
      status: string;
      created_at: string;
      updated_at: string;
      customer_count: string;
      key_count: string;
    }>(
      `SELECT e.id, e.aice_id, e.name, e.description, e.status,
              e.created_at, e.updated_at,
              COUNT(DISTINCT ec.customer_id)::text AS customer_count,
              COUNT(DISTINCT tr.id)::text AS key_count
       FROM aice_environments e
       LEFT JOIN aice_environment_customers ec ON ec.aice_id = e.aice_id
       LEFT JOIN trust_registry tr ON tr.aice_id = e.aice_id
       GROUP BY e.id
       ORDER BY e.created_at`,
    );

    return Response.json({
      environments: result.rows.map((r) => ({
        id: r.id,
        aiceId: r.aice_id,
        name: r.name,
        description: r.description,
        status: r.status,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
        customerCount: Number(r.customer_count),
        keyCount: Number(r.key_count),
      })),
    });
  },
  { ctx: "admin" },
);

const AICE_ID_RE = /^[a-zA-Z0-9_-]{1,128}$/;

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

    const { aiceId, name, description, status, trustRegistryKey } =
      raw as Record<string, unknown>;

    if (
      typeof aiceId !== "string" ||
      typeof name !== "string" ||
      !aiceId.trim() ||
      !name.trim()
    ) {
      return Response.json(
        { error: "aiceId and name are required non-empty strings" },
        { status: 400 },
      );
    }

    if (!AICE_ID_RE.test(aiceId)) {
      return Response.json(
        { error: "aiceId must be alphanumeric with hyphens/underscores" },
        { status: 400 },
      );
    }

    if (description !== undefined && typeof description !== "string") {
      return Response.json(
        { error: "description must be a string" },
        { status: 400 },
      );
    }

    if (
      status !== undefined &&
      status !== "active" &&
      status !== "suspended" &&
      status !== "disabled"
    ) {
      return Response.json(
        { error: "status must be active, suspended, or disabled" },
        { status: 400 },
      );
    }

    // Validate optional trust registry key
    let parsedKeyExpiresAt: Date | null = null;
    if (trustRegistryKey !== undefined) {
      if (
        typeof trustRegistryKey !== "object" ||
        trustRegistryKey === null ||
        Array.isArray(trustRegistryKey)
      ) {
        return Response.json(
          { error: "trustRegistryKey must be an object" },
          { status: 400 },
        );
      }
      const trk = trustRegistryKey as Record<string, unknown>;
      if (
        typeof trk.issuer !== "string" ||
        typeof trk.kid !== "string" ||
        !trk.issuer.trim() ||
        !trk.kid.trim()
      ) {
        return Response.json(
          {
            error:
              "trustRegistryKey.issuer and trustRegistryKey.kid are required",
          },
          { status: 400 },
        );
      }
      if (
        typeof trk.publicKey !== "object" ||
        trk.publicKey === null ||
        Array.isArray(trk.publicKey)
      ) {
        return Response.json(
          { error: "trustRegistryKey.publicKey must be a JWK object" },
          { status: 400 },
        );
      }

      const expiresAtParse = parseExpiresAtInput(trk.expiresAt);
      if (!expiresAtParse.ok) {
        return Response.json(
          { error: expiresAtParse.error, field: "trustRegistryKey.expiresAt" },
          { status: 400 },
        );
      }
      parsedKeyExpiresAt = expiresAtParse.expiresAt;

      // Combined registration requires trust-registry:write as well
      const trAuthzClient = await pool.connect();
      try {
        await assertAuthorized(
          trAuthzClient,
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
        trAuthzClient.release();
      }
    }

    // Compute the server-side thumbprint up-front. This both validates the
    // JWK (so we 400 before any DB writes) and produces the value we persist
    // into the audit trail — the operator confirmed this exact thumbprint on
    // the registration screen.
    let trustRegistryThumbprint: string | null = null;
    if (trustRegistryKey) {
      const trk = trustRegistryKey as Record<string, unknown>;
      try {
        const tp = await computeJwkThumbprint(trk.publicKey);
        trustRegistryThumbprint = tp.base64url;
      } catch (err) {
        if (err instanceof InvalidJwkError) {
          return Response.json({ error: err.message }, { status: 400 });
        }
        throw err;
      }
    }

    try {
      const result = await withTransaction(pool, async (client) => {
        const envResult = await client.query<{
          id: number;
          aice_id: string;
          name: string;
          description: string | null;
          status: string;
        }>(
          `INSERT INTO aice_environments (aice_id, name, description, status)
           VALUES ($1, $2, $3, $4)
           RETURNING id, aice_id, name, description, status`,
          [
            aiceId,
            name.trim(),
            typeof description === "string" ? description : null,
            typeof status === "string" ? status : "active",
          ],
        );

        let registeredKey: {
          id: number;
          issuer: string;
          kid: string;
          expiresAt: string | null;
        } | null = null;

        if (trustRegistryKey) {
          const trk = trustRegistryKey as Record<string, unknown>;
          const keyResult = await client.query<{
            id: number;
            issuer: string;
            kid: string;
            expires_at: string | Date | null;
          }>(
            `INSERT INTO trust_registry (aice_id, issuer, kid, public_key, description, expires_at)
             VALUES ($1, $2, $3, $4, $5, $6)
             RETURNING id, issuer, kid, expires_at`,
            [
              aiceId,
              (trk.issuer as string).trim(),
              (trk.kid as string).trim(),
              JSON.stringify(trk.publicKey),
              typeof trk.description === "string" ? trk.description : null,
              parsedKeyExpiresAt,
            ],
          );
          const row = keyResult.rows[0];
          registeredKey = {
            id: row.id,
            issuer: row.issuer,
            kid: row.kid,
            expiresAt:
              row.expires_at instanceof Date
                ? row.expires_at.toISOString()
                : row.expires_at,
          };
        }

        return { env: envResult.rows[0], registeredKey };
      });

      auth.audit.targetId = result.env.aice_id;
      auth.audit.details = {
        name: result.env.name,
        aiceId: result.env.aice_id,
        status: result.env.status,
        hasTrustRegistryKey: result.registeredKey !== null,
      };

      if (result.registeredKey) {
        // Force a fresh trust-registry cache load so the new key (and its
        // expires_at) is visible without waiting up to CACHE_TTL_MS.
        invalidateTrustRegistryCache();
        void auditLog({
          actorId: auth.accountId,
          authContext: "admin",
          action: "trust_registry.key_registered",
          targetType: "trust_registry",
          targetId: String(result.registeredKey.id),
          details: {
            aiceId: result.env.aice_id,
            issuer: result.registeredKey.issuer,
            kid: result.registeredKey.kid,
            jwkThumbprint: trustRegistryThumbprint,
            expiresAt: result.registeredKey.expiresAt,
          },
          ipAddress: auth.meta.ipAddress,
          sid: auth.sessionId,
          aiceId: result.env.aice_id,
        });
      }

      return Response.json(
        {
          id: result.env.id,
          aiceId: result.env.aice_id,
          name: result.env.name,
          description: result.env.description,
          status: result.env.status,
          trustRegistryKey: result.registeredKey,
        },
        { status: 201 },
      );
    } catch (err: unknown) {
      const pgErr = err as { code?: string; constraint?: string };
      if (
        pgErr.code === "23505" &&
        pgErr.constraint === "aice_environments_aice_id_key"
      ) {
        return Response.json({ error: "aice_id_conflict" }, { status: 409 });
      }
      if (err instanceof HttpError) {
        return Response.json(
          { error: err.message },
          { status: err.statusCode },
        );
      }
      throw err;
    }
  },
  {
    ctx: "admin",
    audit: { action: "environment.created", targetType: "environment" },
  },
);
