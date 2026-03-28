import type { NextRequest } from "next/server";
import { withAuth } from "@/lib/auth/guards";
import {
  expireStagedEvents,
  getStagedPayloadById,
} from "@/lib/auth/staged-events";
import { getAuthPool } from "@/lib/db/client";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const GET = withAuth(async (req: NextRequest, auth) => {
  const segments = req.nextUrl.pathname.split("/");
  const payloadId = segments[segments.length - 1];

  if (!payloadId || !UUID_RE.test(payloadId)) {
    return Response.json(
      { error: "Invalid payloadId format" },
      { status: 400 },
    );
  }

  const pool = getAuthPool();

  // Expire stale payloads before checking
  await expireStagedEvents(pool);

  // Verify the payload belongs to the caller's session and is not expired
  const ownership = await pool.query<{ id: string }>(
    `SELECT id FROM staged_event_payloads
     WHERE id = $1 AND session_id = $2 AND expires_at > NOW()`,
    [payloadId, auth.sessionId],
  );
  if (ownership.rows.length === 0) {
    return Response.json({ error: "Not found" }, { status: 404 });
  }

  const event = await getStagedPayloadById(pool, payloadId);
  if (!event) {
    return Response.json({ error: "Not found" }, { status: 404 });
  }

  return Response.json({ event });
});
