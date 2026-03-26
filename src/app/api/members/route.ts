import type { NextRequest } from "next/server";
import { HttpError } from "@/lib/auth/errors";
import { withAuth } from "@/lib/auth/guards";
import { listMembers } from "@/lib/auth/members";
import { getAuthPool, withTransaction } from "@/lib/db/client";

export const GET = withAuth(async (req: NextRequest, auth) => {
  const customerId = req.nextUrl.searchParams.get("customer_id");
  if (!customerId) {
    return Response.json(
      { error: "customer_id query parameter is required" },
      { status: 400 },
    );
  }

  const UUID_RE =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!UUID_RE.test(customerId)) {
    return Response.json(
      { error: "Invalid customer_id format" },
      { status: 400 },
    );
  }

  try {
    const members = await withTransaction(getAuthPool(), (client) =>
      listMembers(client, {
        accountId: auth.accountId,
        customerId,
      }),
    );

    return Response.json({ members });
  } catch (err: unknown) {
    if (err instanceof HttpError) {
      return Response.json({ error: err.message }, { status: err.statusCode });
    }
    throw err;
  }
});
