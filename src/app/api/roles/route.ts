import type { NextRequest } from "next/server";
import { withAuth } from "@/lib/auth/guards";
import { getAuthPool, query } from "@/lib/db/client";

export const GET = withAuth(async (_req: NextRequest, _auth) => {
  const roles = await query<{ id: number; name: string }>(
    getAuthPool(),
    `SELECT id, name FROM roles
     WHERE auth_context = 'general'
     ORDER BY name`,
    [],
  );

  return Response.json({ roles });
});
