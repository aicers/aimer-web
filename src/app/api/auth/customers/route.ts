import type { NextRequest } from "next/server";
import { listAccessibleCustomersDetailed } from "@/lib/auth/authorization";
import { withAuth } from "@/lib/auth/guards";
import { getAuthPool, withTransaction } from "@/lib/db/client";

export const GET = withAuth(async (_req: NextRequest, auth) => {
  const bridgeScope =
    auth.bridgeAiceId && auth.bridgeCustomerIds
      ? { aiceId: auth.bridgeAiceId, customerIds: auth.bridgeCustomerIds }
      : null;

  const customers = await withTransaction(getAuthPool(), (client) =>
    listAccessibleCustomersDetailed(client, auth.accountId, bridgeScope),
  );

  return Response.json({ customers });
});
