import type { NextRequest } from "next/server";
import { assertAuthorized } from "@/lib/auth/authorization";
import { HttpError } from "@/lib/auth/errors";
import { verifyCsrf, verifyOrigin, withAuth } from "@/lib/auth/guards";
import { getAuthPool } from "@/lib/db/client";
import { computeCustomerPolicyVersion } from "@/lib/redaction/customer-policy";
import { isRedactionJobsEnabled } from "@/lib/redaction/feature-flag";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function extractCustomerId(req: NextRequest): string | null {
  // `/api/admin/customers/<id>/redaction-jobs`
  const segments = req.nextUrl.pathname.split("/");
  const id = segments[segments.length - 2];
  if (!id || !UUID_RE.test(id)) return null;
  return id;
}

interface JobRow {
  id: string;
  status: string;
  target_policy_version: string;
}

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

    const customerId = extractCustomerId(req);
    if (!customerId) {
      return Response.json({ error: "Invalid customer ID" }, { status: 400 });
    }

    const pool = getAuthPool();
    const client = await pool.connect();
    try {
      // Permission check must run before the feature-gate so callers
      // without :write keep seeing 403, not 503. The 503 is reserved
      // for callers who would otherwise be allowed.
      await assertAuthorized(
        client,
        "general",
        auth.accountId,
        "customer-redaction-ranges:write",
        { customerId, operationKind: "write" },
      );

      if (!isRedactionJobsEnabled()) {
        return Response.json(
          {
            error: "feature_disabled",
            message:
              "Retroactive re-redact is not yet available in this build.",
          },
          { status: 503 },
        );
      }

      // Return the existing active job if one exists for this
      // customer (the partial unique index enforces the invariant; we
      // check explicitly so re-clicking returns 200 with the existing
      // row rather than relying on an INSERT race).
      const existing = await client.query<JobRow>(
        `SELECT id, status, target_policy_version
         FROM redaction_jobs
         WHERE customer_id = $1 AND status IN ('queued', 'running')
         LIMIT 1`,
        [customerId],
      );
      if (existing.rows.length > 0) {
        const row = existing.rows[0];
        return Response.json({
          job_id: row.id,
          status: row.status,
          target_policy_version: row.target_policy_version,
        });
      }

      const target = await computeCustomerPolicyVersion(client, customerId);

      let row: JobRow;
      try {
        const inserted = await client.query<JobRow>(
          `INSERT INTO redaction_jobs
             (customer_id, status, target_policy_version, triggered_by)
           VALUES ($1, 'queued', $2, $3)
           RETURNING id, status, target_policy_version`,
          [customerId, target, auth.accountId],
        );
        row = inserted.rows[0];
      } catch (insertErr) {
        // The partial unique index `redaction_jobs_one_active_per_customer`
        // is the source of truth for "at most one active job per
        // customer". Two concurrent triggers can both observe no
        // active job above and race into INSERT; the loser sees a
        // 23505. Translate that into the documented "return the
        // existing active job" behaviour rather than surfacing a 500.
        if (isActiveJobUniqueViolation(insertErr)) {
          const reSelect = await client.query<JobRow>(
            `SELECT id, status, target_policy_version
             FROM redaction_jobs
             WHERE customer_id = $1 AND status IN ('queued', 'running')
             LIMIT 1`,
            [customerId],
          );
          if (reSelect.rows.length > 0) {
            const winner = reSelect.rows[0];
            return Response.json({
              job_id: winner.id,
              status: winner.status,
              target_policy_version: winner.target_policy_version,
            });
          }
        }
        throw insertErr;
      }

      return Response.json(
        {
          job_id: row.id,
          status: row.status,
          target_policy_version: row.target_policy_version,
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

function isActiveJobUniqueViolation(err: unknown): boolean {
  // PostgreSQL SQLSTATE `23505` (unique_violation). `pg` surfaces the
  // constraint name on the error object's `constraint` field; gate
  // on it so other unique constraints on `redaction_jobs` (future
  // additions, or the PK in a collision-resistant test mock) do not
  // accidentally trigger the "return existing active job" path.
  if (typeof err !== "object" || err === null) return false;
  const e = err as { code?: unknown; constraint?: unknown };
  if (e.code !== "23505") return false;
  return e.constraint === "redaction_jobs_one_active_per_customer";
}
