import type { NextRequest } from "next/server";
import { assertAuthorized } from "@/lib/auth/authorization";
import { HttpError } from "@/lib/auth/errors";
import { verifyCsrf, verifyOrigin, withAuth } from "@/lib/auth/guards";
import {
  computeJwkThumbprint,
  InvalidJwkError,
} from "@/lib/auth/jwk-thumbprint";
import { getAuthPool } from "@/lib/db/client";

/**
 * Compute the server-side JWK Thumbprint for a pasted public key. Used by the
 * environment registration / "Register key" UI to show the operator the
 * thumbprint they should compare out-of-band against the value displayed by
 * aice-web-next, before they confirm the registration.
 *
 * The server's value here is informational for the UI only; the registration
 * routes recompute the thumbprint themselves and persist that value into
 * audit details, so a tampered client cannot inject a different thumbprint.
 */
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
    const client = await pool.connect();
    try {
      await assertAuthorized(
        client,
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
      client.release();
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

    const { publicKey } = raw as Record<string, unknown>;

    try {
      const thumbprint = await computeJwkThumbprint(publicKey);
      return Response.json(thumbprint);
    } catch (err) {
      if (err instanceof InvalidJwkError) {
        return Response.json({ error: err.message }, { status: 400 });
      }
      throw err;
    }
  },
  { ctx: "admin" },
);
