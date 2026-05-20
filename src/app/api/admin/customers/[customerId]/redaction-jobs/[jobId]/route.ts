import type { NextRequest } from "next/server";
import { auditLog } from "@/lib/audit";
import { assertAuthorized } from "@/lib/auth/authorization";
import { HttpError } from "@/lib/auth/errors";
import { verifyCsrf, verifyOrigin, withAuth } from "@/lib/auth/guards";
import { getAuthPool } from "@/lib/db/client";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface JobRow {
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
  customer_id: string;
}

function extractIds(
  req: NextRequest,
): { customerId: string; jobId: string } | null {
  // `/api/admin/customers/<id>/redaction-jobs/<job_id>`
  const segments = req.nextUrl.pathname.split("/");
  const jobId = segments[segments.length - 1];
  const customerId = segments[segments.length - 3];
  if (
    !jobId ||
    !customerId ||
    !UUID_RE.test(customerId) ||
    !UUID_RE.test(jobId)
  ) {
    return null;
  }
  return { customerId, jobId };
}

function serializeJobRow(row: JobRow) {
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

export const GET = withAuth(
  async (req: NextRequest, auth) => {
    const ids = extractIds(req);
    if (!ids) {
      return Response.json({ error: "Invalid identifiers" }, { status: 400 });
    }

    const pool = getAuthPool();
    const client = await pool.connect();
    try {
      await assertAuthorized(
        client,
        "general",
        auth.accountId,
        "customer-redaction-ranges:read",
        { customerId: ids.customerId },
      );

      const { rows } = await client.query<JobRow>(
        `SELECT id AS job_id, customer_id, status, target_policy_version,
                total_rows, processed_rows, failed_rows,
                started_at, running_started_at, completed_at,
                last_progress_at, error_message, triggered_by,
                cancelled_by, cancellation_reason
           FROM redaction_jobs
          WHERE id = $1 AND customer_id = $2`,
        [ids.jobId, ids.customerId],
      );
      if (rows.length === 0) {
        return Response.json({ error: "not_found" }, { status: 404 });
      }
      return Response.json(serializeJobRow(rows[0]));
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

export const DELETE = withAuth(
  async (req: NextRequest, auth) => {
    const originErr = verifyOrigin(req);
    if (originErr) return originErr;

    const csrfErr = verifyCsrf(req, {
      ctx: "general",
      sid: auth.sessionId,
      iat: auth.iat,
    });
    if (csrfErr) return csrfErr;

    const ids = extractIds(req);
    if (!ids) {
      return Response.json({ error: "Invalid identifiers" }, { status: 400 });
    }

    let reason: string | null = null;
    try {
      const text = await req.text();
      if (text) {
        const parsed = JSON.parse(text);
        if (
          parsed &&
          typeof parsed === "object" &&
          typeof (parsed as { reason?: unknown }).reason === "string"
        ) {
          reason = (parsed as { reason: string }).reason.slice(0, 500);
        }
      }
    } catch {
      // Ignore malformed bodies; reason stays null.
    }

    const pool = getAuthPool();
    const client = await pool.connect();
    try {
      await assertAuthorized(
        client,
        "general",
        auth.accountId,
        "customer-redaction-ranges:write",
        { customerId: ids.customerId, operationKind: "write" },
      );

      // Check existence + customer scoping first so cross-customer
      // lookups return 404, not 409.
      const existing = await client.query<{ status: string }>(
        `SELECT status FROM redaction_jobs
          WHERE id = $1 AND customer_id = $2`,
        [ids.jobId, ids.customerId],
      );
      if (existing.rows.length === 0) {
        return Response.json({ error: "not_found" }, { status: 404 });
      }
      const currentStatus = existing.rows[0].status;
      if (
        currentStatus === "completed" ||
        currentStatus === "failed" ||
        currentStatus === "cancelled"
      ) {
        return Response.json({ error: "job_terminal" }, { status: 409 });
      }

      // CTE so the prior status is captured under FOR UPDATE in the same
      // statement as the cancellation flip. We need the prior status to
      // decide who owns the audit emission:
      //   - prev_status='queued' → no worker will observe this row
      //     before we COMMIT, so the endpoint owns the audit (counters
      //     are guaranteed zero here).
      //   - prev_status='running' → the worker may still finish its
      //     current batch and write the final counters before
      //     finalizing; emitting from the endpoint at this point would
      //     audit a stale processed_rows/failed_rows snapshot. Defer to
      //     the worker, which audits after the final checkpoint.
      const updated = await client.query<{
        prev_status: string;
        processed_rows: string;
        failed_rows: string;
        target_policy_version: string;
      }>(
        `WITH locked AS (
           SELECT id, status FROM redaction_jobs
            WHERE id = $1 AND customer_id = $2
            FOR UPDATE
         )
         UPDATE redaction_jobs r
            SET status = 'cancelled',
                cancelled_by = $3,
                cancellation_reason = $4,
                completed_at = NOW(),
                last_progress_at = NOW()
           FROM locked
          WHERE r.id = locked.id
            AND locked.status IN ('queued','running')
         RETURNING locked.status AS prev_status,
                   r.processed_rows::text AS processed_rows,
                   r.failed_rows::text AS failed_rows,
                   r.target_policy_version`,
        [ids.jobId, ids.customerId, auth.accountId, reason],
      );
      if (updated.rows.length === 0) {
        // Lost a race against a concurrent terminal flip.
        return Response.json({ error: "job_terminal" }, { status: 409 });
      }

      const winner = updated.rows[0];
      if (winner.prev_status === "queued") {
        await auditLog({
          actorId: auth.accountId,
          authContext: "general",
          action: "customer_redaction_ranges.retroactive_cancelled",
          targetType: "customer",
          targetId: ids.customerId,
          customerId: ids.customerId,
          details: {
            customerId: ids.customerId,
            jobId: ids.jobId,
            targetPolicyVersion: winner.target_policy_version,
            processedRows: Number(winner.processed_rows),
            failedRows: Number(winner.failed_rows),
            cancelledBy: auth.accountId,
            cancellationReason: reason,
          },
        });
      }

      return Response.json({ job_id: ids.jobId, status: "cancelled" });
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
