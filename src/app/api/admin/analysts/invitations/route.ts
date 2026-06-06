import { after, type NextRequest } from "next/server";
import { getCorrelationId } from "@/lib/audit";
import {
  createAnalystInvitation,
  deliverAnalystInvitation,
  listPendingAnalystInvitations,
} from "@/lib/auth/analyst-invitations";
import { assertAuthorized } from "@/lib/auth/authorization";
import { canonicalOrigin } from "@/lib/auth/canonical-origin";
import { HttpError } from "@/lib/auth/errors";
import { verifyCsrf, verifyOrigin, withAuth } from "@/lib/auth/guards";
import { getAuthPool, withTransaction } from "@/lib/db/client";

// ---------------------------------------------------------------------------
// GET /api/admin/analysts/invitations — list pending
// ---------------------------------------------------------------------------

export const GET = withAuth(
  async (_req, auth) => {
    const pool = getAuthPool();
    const client = await pool.connect();
    try {
      await assertAuthorized(client, "admin", auth.accountId, "analysts:read");
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

    const invitations = await listPendingAnalystInvitations(pool);
    return Response.json({ invitations });
  },
  { ctx: "admin" },
);

// ---------------------------------------------------------------------------
// POST /api/admin/analysts/invitations — create (or refresh)
//
// No declarative `audit` option here: the `invitation.created` event must
// carry the real post-send `emailDelivery` outcome, which the guard-level
// auto-emit (fires at response-build time) cannot observe. The audit is
// emitted manually from `after()` once the send resolves.
// ---------------------------------------------------------------------------

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
        "analysts:write",
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

    const { email, customerIds } = raw as Record<string, unknown>;
    if (typeof email !== "string") {
      return Response.json({ error: "invalid_email" }, { status: 400 });
    }
    if (!Array.isArray(customerIds)) {
      return Response.json({ error: "invalid_customer_ids" }, { status: 400 });
    }

    let created: Awaited<ReturnType<typeof createAnalystInvitation>>;
    try {
      created = await withTransaction(pool, (client) =>
        createAnalystInvitation(client, {
          accountId: auth.accountId,
          email,
          customerIds: customerIds as string[],
        }),
      );
    } catch (err) {
      if (err instanceof HttpError) {
        return Response.json(
          { error: err.message },
          { status: err.statusCode },
        );
      }
      throw err;
    }

    // Capture the correlation id synchronously — the AsyncLocalStorage scope
    // may no longer be active inside the deferred `after()` callback.
    const correlationId = getCorrelationId() ?? undefined;
    const baseUrl = canonicalOrigin(req);

    // Email send + manual audit run after the response, so the 201 does not
    // block on email latency yet the audit still reflects the real outcome.
    after(async () => {
      await deliverAnalystInvitation({
        invitationId: created.id,
        email: created.email,
        token: created.token,
        customerNames: created.customerNames,
        customerIds: created.customerIds,
        expiresAt: created.expiresAt,
        baseUrl,
        refreshed: created.refreshed,
        actor: {
          accountId: auth.accountId,
          ipAddress: auth.meta.ipAddress,
          sid: auth.sessionId,
          correlationId,
        },
      });
    });

    return Response.json(
      {
        id: created.id,
        email: created.email,
        customerIds: created.customerIds,
        expiresAt: created.expiresAt.toISOString(),
        refreshed: created.refreshed,
      },
      { status: 201 },
    );
  },
  { ctx: "admin" },
);
