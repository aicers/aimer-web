import type { NextRequest } from "next/server";
import { assertAuthorized } from "@/lib/auth/authorization";
import { HttpError } from "@/lib/auth/errors";
import { verifyCsrf, verifyOrigin, withAuth } from "@/lib/auth/guards";
import { getAuthPool } from "@/lib/db/client";
import { computeCustomerPolicyVersion } from "@/lib/redaction/customer-policy";

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

interface ListJobRow {
  job_id: string;
  status: string;
  target_policy_version: string;
  total_rows: string | null;
  processed_rows: string;
  failed_rows: string;
  started_at: Date;
  running_started_at: Date | null;
  completed_at: Date | null;
  last_progress_at: Date;
  error_message: string | null;
  triggered_by: string;
  cancelled_by: string | null;
  cancellation_reason: string | null;
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
        "customer-redaction-ranges:read",
        { customerId },
      );

      const url = req.nextUrl;
      const before = url.searchParams.get("before");
      const pageSizeRaw = url.searchParams.get("page_size");
      const pageSize = Math.min(
        MAX_PAGE_SIZE,
        Math.max(
          1,
          Number.parseInt(pageSizeRaw ?? "", 10) || DEFAULT_PAGE_SIZE,
        ),
      );

      const params: unknown[] = [customerId];
      let whereClause = "WHERE customer_id = $1";
      if (before && UUID_RE.test(before)) {
        whereClause +=
          " AND started_at < (SELECT started_at FROM redaction_jobs WHERE id = $2)";
        params.push(before);
      }

      const { rows } = await client.query<ListJobRow>(
        `SELECT id AS job_id, status, target_policy_version,
                total_rows, processed_rows, failed_rows,
                started_at, running_started_at, completed_at,
                last_progress_at, error_message, triggered_by,
                cancelled_by, cancellation_reason
           FROM redaction_jobs
           ${whereClause}
          ORDER BY started_at DESC
          LIMIT ${pageSize + 1}`,
        params,
      );

      const slice = rows.slice(0, pageSize);
      const nextCursor =
        rows.length > pageSize
          ? (slice[slice.length - 1]?.job_id ?? null)
          : null;

      return Response.json({
        jobs: slice.map(serializeJobRow),
        next_cursor: nextCursor,
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

function serializeJobRow(row: ListJobRow) {
  return {
    job_id: row.job_id,
    status: row.status,
    target_policy_version: row.target_policy_version,
    total_rows: row.total_rows == null ? null : Number(row.total_rows),
    processed_rows: Number(row.processed_rows),
    failed_rows: Number(row.failed_rows),
    started_at: row.started_at.toISOString(),
    running_started_at: row.running_started_at?.toISOString() ?? null,
    completed_at: row.completed_at?.toISOString() ?? null,
    last_progress_at: row.last_progress_at.toISOString(),
    error_message: row.error_message,
    triggered_by: row.triggered_by,
    cancelled_by: row.cancelled_by,
    cancellation_reason: row.cancellation_reason,
  };
}

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
      await assertAuthorized(
        client,
        "general",
        auth.accountId,
        "customer-redaction-ranges:write",
        { customerId, operationKind: "write" },
      );

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
