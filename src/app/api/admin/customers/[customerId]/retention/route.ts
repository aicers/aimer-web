import type { NextRequest } from "next/server";
import { auditLog } from "@/lib/audit";
import { assertAuthorized } from "@/lib/auth/authorization";
import { HttpError } from "@/lib/auth/errors";
import { verifyCsrf, verifyOrigin, withAuth } from "@/lib/auth/guards";
import { getAuthPool } from "@/lib/db/client";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const RETENTION_MIN_DAYS = 30;

function extractCustomerId(req: NextRequest): string | null {
  const segments = req.nextUrl.pathname.split("/");
  const id = segments[segments.length - 2];
  if (!id || !UUID_RE.test(id)) return null;
  return id;
}

interface RetentionRow {
  ingestion_days: number;
  analysis_days: number | null;
}

export const GET = withAuth(
  async (req: NextRequest, auth) => {
    const customerId = extractCustomerId(req);
    if (!customerId) {
      return Response.json({ error: "Invalid customer ID" }, { status: 400 });
    }

    const pool = getAuthPool();
    const client = await pool.connect();
    try {
      await assertAuthorized(
        client,
        "general",
        auth.accountId,
        "customer-retention:read",
        { customerId },
      );
      const { rows } = await client.query<RetentionRow>(
        `SELECT ingestion_days, analysis_days
         FROM customer_retention_policy
         WHERE customer_id = $1`,
        [customerId],
      );
      if (rows.length === 0) {
        return Response.json(
          { error: "Retention policy not found" },
          { status: 404 },
        );
      }
      const row = rows[0];
      return Response.json({
        ingestion_days: row.ingestion_days,
        analysis_days: row.analysis_days,
      });
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

interface PutBody {
  ingestion_days?: unknown;
  analysis_days?: unknown;
}

function parseRetentionBody(
  raw: PutBody,
):
  | { ok: true; ingestionDays: number; analysisDays: number | null }
  | { ok: false; error: string; status: number } {
  const ingestionDays = raw.ingestion_days;
  const analysisDays = raw.analysis_days;

  if (typeof ingestionDays !== "number" || !Number.isInteger(ingestionDays)) {
    return { ok: false, error: "ingestion_days_required", status: 400 };
  }
  if (
    analysisDays !== null &&
    (typeof analysisDays !== "number" || !Number.isInteger(analysisDays))
  ) {
    return { ok: false, error: "analysis_days_required", status: 400 };
  }

  if (ingestionDays < RETENTION_MIN_DAYS) {
    return { ok: false, error: "retention_too_short", status: 422 };
  }
  if (analysisDays !== null && analysisDays < RETENTION_MIN_DAYS) {
    return { ok: false, error: "retention_too_short", status: 422 };
  }

  return {
    ok: true,
    ingestionDays,
    analysisDays: analysisDays === null ? null : (analysisDays as number),
  };
}

export const PUT = withAuth(
  async (req: NextRequest, auth) => {
    const originErr = verifyOrigin(req);
    if (originErr) return originErr;

    const csrfErr = verifyCsrf(req, {
      ctx: "general",
      sid: auth.sessionId,
      iat: auth.iat,
    });
    if (csrfErr) return csrfErr;

    const customerId = extractCustomerId(req);
    if (!customerId) {
      return Response.json({ error: "Invalid customer ID" }, { status: 400 });
    }

    const pool = getAuthPool();
    const client = await pool.connect();
    try {
      // Authorize before parsing / validating the body so a read-only
      // caller consistently sees 403 rather than 400 / 422 messages
      // that leak write-endpoint validation rules.
      await assertAuthorized(
        client,
        "general",
        auth.accountId,
        "customer-retention:write",
        { customerId, operationKind: "write" },
      );

      let raw: unknown;
      try {
        raw = await req.json();
      } catch {
        return Response.json({ error: "Invalid JSON" }, { status: 400 });
      }
      if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
        return Response.json({ error: "Invalid body" }, { status: 400 });
      }

      const parsed = parseRetentionBody(raw as PutBody);
      if (!parsed.ok) {
        return Response.json(
          { error: parsed.error },
          { status: parsed.status },
        );
      }

      // Read-update in one round so we can both produce a meaningful
      // audit "before" snapshot and skip emission on no-op writes.
      const before = await client.query<RetentionRow>(
        `SELECT ingestion_days, analysis_days
         FROM customer_retention_policy
         WHERE customer_id = $1`,
        [customerId],
      );
      if (before.rows.length === 0) {
        return Response.json(
          { error: "Retention policy not found" },
          { status: 404 },
        );
      }
      const prev = before.rows[0];

      const noChange =
        prev.ingestion_days === parsed.ingestionDays &&
        prev.analysis_days === parsed.analysisDays;

      if (!noChange) {
        await client.query(
          `UPDATE customer_retention_policy
             SET ingestion_days = $2,
                 analysis_days = $3,
                 updated_at = NOW(),
                 updated_by = $4
           WHERE customer_id = $1`,
          [
            customerId,
            parsed.ingestionDays,
            parsed.analysisDays,
            auth.accountId,
          ],
        );

        // Audit is emitted manually here rather than via `withAuth`'s
        // `audit` option because the spec requires that a no-op PUT
        // (body equal to current values) emit nothing — and the guard
        // emits unconditionally on any 2xx response.
        void auditLog({
          actorId: auth.accountId,
          authContext: "general",
          action: "customer_retention_policy.updated",
          targetType: "customer_retention_policy",
          targetId: customerId,
          customerId,
          ipAddress: auth.meta.ipAddress,
          sid: auth.sessionId,
          details: {
            customerId,
            before: {
              ingestion_days: prev.ingestion_days,
              analysis_days: prev.analysis_days,
            },
            after: {
              ingestion_days: parsed.ingestionDays,
              analysis_days: parsed.analysisDays,
            },
          },
        });
      }

      return Response.json({
        ingestion_days: parsed.ingestionDays,
        analysis_days: parsed.analysisDays,
        changed: !noChange,
      });
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
