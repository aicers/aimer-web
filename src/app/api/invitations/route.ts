import type { NextRequest } from "next/server";
import { HttpError } from "@/lib/auth/errors";
import { verifyCsrf, verifyOrigin, withAuth } from "@/lib/auth/guards";
import { listPendingInvitations } from "@/lib/auth/invitation-management";
import { createInvitation } from "@/lib/auth/invitations";
import { getAuthPool, withTransaction } from "@/lib/db/client";
import { sendInvitationEmail } from "@/lib/email/invitation";

// ---------------------------------------------------------------------------
// GET /api/invitations?customer_id=...
// ---------------------------------------------------------------------------

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const GET = withAuth(async (req: NextRequest, auth) => {
  const customerId = req.nextUrl.searchParams.get("customer_id");
  if (!customerId || !UUID_RE.test(customerId)) {
    return Response.json(
      { error: "customer_id query parameter is required and must be a UUID" },
      { status: 400 },
    );
  }

  try {
    const invitations = await listPendingInvitations(
      getAuthPool(),
      auth.accountId,
      customerId,
    );
    return Response.json({ invitations });
  } catch (err: unknown) {
    if (err instanceof HttpError) {
      return Response.json({ error: err.message }, { status: err.statusCode });
    }
    throw err;
  }
});

// ---------------------------------------------------------------------------
// POST /api/invitations
// ---------------------------------------------------------------------------

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

    // Parse and validate request body
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

    const { customerId, email, role } = raw as Record<string, unknown>;
    if (
      typeof customerId !== "string" ||
      typeof email !== "string" ||
      typeof role !== "string"
    ) {
      return Response.json(
        { error: "customerId, email, and role are required strings" },
        { status: 400 },
      );
    }

    if (!UUID_RE.test(customerId)) {
      return Response.json(
        { error: "Invalid customerId format" },
        { status: 400 },
      );
    }

    try {
      const result = await withTransaction(getAuthPool(), (client) =>
        createInvitation(client, {
          accountId: auth.accountId,
          customerId,
          email,
          roleName: role,
        }),
      );

      auth.audit.targetId = result.id;
      auth.audit.details = { customerId, email, role };
      auth.audit.customerId = customerId;

      // Fire-and-forget: email failure must not affect the API response.
      sendInvitationEmail({
        to: email,
        token: result.token,
        customerName: result.customerName,
        roleName: role,
        expiresAt: result.expiresAt,
        baseUrl: req.nextUrl.origin,
      }).catch((err) =>
        console.error("[email] Failed to send invitation:", err),
      );

      return Response.json(
        { id: result.id, expiresAt: result.expiresAt.toISOString() },
        { status: 201 },
      );
    } catch (err: unknown) {
      if (err instanceof HttpError) {
        return Response.json(
          { error: err.message },
          { status: err.statusCode },
        );
      }
      throw err;
    }
  },
  { audit: { action: "invitation.created", targetType: "invitation" } },
);
