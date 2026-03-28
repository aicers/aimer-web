import type { NextRequest } from "next/server";
import { listAccessibleEnvironments } from "@/lib/auth/authorization";
import { withAuth } from "@/lib/auth/guards";
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

  const bridgeScope =
    auth.bridgeAiceId && auth.bridgeCustomerIds
      ? { aiceId: auth.bridgeAiceId, customerIds: auth.bridgeCustomerIds }
      : null;

  const environments = await withTransaction(getAuthPool(), (client) =>
    listAccessibleEnvironments(client, auth.accountId, customerId, bridgeScope),
  );

  return Response.json({ environments });
});
