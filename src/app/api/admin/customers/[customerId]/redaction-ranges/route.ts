import type { NextRequest } from "next/server";
import { assertAuthorized } from "@/lib/auth/authorization";
import { HttpError } from "@/lib/auth/errors";
import { verifyCsrf, verifyOrigin, withAuth } from "@/lib/auth/guards";
import { getAuthPool } from "@/lib/db/client";
import {
  RANGE_CAP_PER_CUSTOMER,
  validateNewRange,
} from "@/lib/redaction/cidr-validation";

// `/api/admin/customers/<customerId>/redaction-ranges` — listing and add.
// Per issue #252's "Auth context decision", the customer-settings
// permission keys are checked against `authorizeGeneral` even though
// the path prefix says `/admin/`. The prefix is a routing convention
// only — the CSRF cookie and `authContext` are both `general`.

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function extractCustomerId(req: NextRequest): string | null {
  // Path is `/api/admin/customers/<id>/redaction-ranges` — customer id
  // is the third-from-last segment.
  const segments = req.nextUrl.pathname.split("/");
  const id = segments[segments.length - 2];
  if (!id || !UUID_RE.test(id)) return null;
  return id;
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
      const { rows } = await client.query<{
        id: string;
        cidr: string;
        ip_version: number;
        created_at: string;
      }>(
        `SELECT id, cidr::text AS cidr, ip_version, created_at
         FROM customer_redaction_ranges
         WHERE customer_id = $1
         ORDER BY created_at`,
        [customerId],
      );
      return Response.json({
        ranges: rows.map((r) => ({
          id: r.id,
          cidr: r.cidr,
          ipVersion: r.ip_version,
          createdAt: r.created_at,
        })),
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

      let raw: unknown;
      try {
        raw = await req.json();
      } catch {
        return Response.json({ error: "Invalid JSON" }, { status: 400 });
      }
      if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
        return Response.json({ error: "cidr_invalid" }, { status: 422 });
      }
      const { cidr } = raw as { cidr?: unknown };
      if (typeof cidr !== "string") {
        return Response.json({ error: "cidr_invalid" }, { status: 422 });
      }

      // Serialize range mutations per customer so concurrent POSTs
      // cannot both pass the in-memory cap / overlap / duplicate
      // checks against the same snapshot and then double-insert.
      // `pg_advisory_xact_lock` is released on COMMIT / ROLLBACK.
      // Scoping by `hashtext(customer_id)` keeps unrelated customers'
      // mutations parallel; the table-level UNIQUE constraint backs
      // up exact-duplicate detection regardless.
      try {
        await client.query("BEGIN");
        await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
          `redaction-ranges:${customerId}`,
        ]);

        const existingRes = await client.query<{
          cidr: string;
          ip_version: number;
        }>(
          `SELECT cidr::text AS cidr, ip_version
           FROM customer_redaction_ranges
           WHERE customer_id = $1`,
          [customerId],
        );
        const existing = existingRes.rows.map((r) => ({
          normalised: r.cidr,
          ipVersion: r.ip_version as 4 | 6,
        }));

        const result = validateNewRange(cidr, existing);
        if (!result.ok) {
          await client.query("ROLLBACK");
          return Response.json(
            {
              error: result.error,
              message: errorMessage(result.error),
            },
            { status: 422 },
          );
        }

        const { parsed } = result.value;

        let row: { id: string; created_at: string };
        try {
          const inserted = await client.query<{
            id: string;
            created_at: string;
          }>(
            `INSERT INTO customer_redaction_ranges
               (customer_id, cidr, ip_version, created_by)
             VALUES ($1, $2::cidr, $3, $4)
             RETURNING id, created_at`,
            [customerId, parsed.normalised, parsed.ipVersion, auth.accountId],
          );
          row = inserted.rows[0];
        } catch (insertErr) {
          await client.query("ROLLBACK");
          // The advisory lock should make this path unreachable in
          // practice, but the table-level `UNIQUE (customer_id, cidr)`
          // remains the source of truth — map the constraint violation
          // back to the documented error code rather than surfacing a
          // 500.
          if (isUniqueViolation(insertErr)) {
            return Response.json(
              {
                error: "cidr_duplicate",
                message: errorMessage("cidr_duplicate"),
              },
              { status: 422 },
            );
          }
          throw insertErr;
        }

        await client.query("COMMIT");

        auth.audit.targetId = row.id;
        auth.audit.customerId = customerId;
        auth.audit.details = {
          customerId,
          cidr: parsed.normalised,
          rangeId: row.id,
        };

        return Response.json(
          {
            id: row.id,
            cidr: parsed.normalised,
            ipVersion: parsed.ipVersion,
            createdAt: row.created_at,
          },
          { status: 201 },
        );
      } catch (txErr) {
        // Best-effort rollback for any earlier-stage failure inside
        // the transaction. Safe even after COMMIT — pg silently
        // no-ops on "no transaction".
        try {
          await client.query("ROLLBACK");
        } catch {
          // ignore
        }
        throw txErr;
      }
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
  {
    ctx: "general",
    audit: {
      action: "customer_redaction_ranges.added",
      targetType: "customer_redaction_range",
    },
  },
);

function isUniqueViolation(err: unknown): boolean {
  // PostgreSQL SQLSTATE `23505` (unique_violation) is surfaced by
  // `pg` on the error object's `code` field. Use a structural check
  // rather than `instanceof` so this works regardless of which pg
  // version (or test mock) raised the error.
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: unknown }).code === "23505"
  );
}

function errorMessage(code: string): string {
  switch (code) {
    case "cidr_invalid":
      return "CIDR is not a syntactically valid IPv4 or IPv6 range.";
    case "cidr_private":
      return "CIDR falls inside a private / reserved range (RFC 1918, IPv6 ULA, loopback, link-local).";
    case "cidr_duplicate":
      return "CIDR is already registered for this customer.";
    case "cidr_overlaps":
      return "CIDR overlaps with an existing registered range for this customer.";
    case "cidr_cap_exceeded":
      return `Customer already has ${RANGE_CAP_PER_CUSTOMER} registered ranges.`;
    default:
      return code;
  }
}
