import type { NextRequest } from "next/server";
import { withAuth } from "@/lib/auth/guards";
import { listStagedEventsBySession } from "@/lib/auth/staged-events";
import { getAuthPool } from "@/lib/db/client";

export const GET = withAuth(async (_req: NextRequest, auth) => {
  const events = await listStagedEventsBySession(getAuthPool(), auth.sessionId);
  return Response.json({ events });
});
