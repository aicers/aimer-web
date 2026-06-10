import type { NextRequest } from "next/server";
import { withAuth } from "@/lib/auth/guards";
import { getAuthPool, withTransaction } from "@/lib/db/client";
import { listGroupEligibleMembers } from "@/lib/groups/eligible-members";

// GET /api/groups/eligible-members — the customers the caller may pick as
// group members for the create flow: accessible AND manageable (Manager or
// eligible Analyst) AND operational (status + database_status active), each
// with its timezone for the client-side tz auto-fill / recommendation.
//
// A UX pre-filter only — the authoritative permission / cap / operational
// checks run server-side in `validateGroupMembers` and the preview route.
// Bridge sessions get `{ customers: [] }`: a bridge holds no management grant,
// so it could pick nothing, and the settings surface is not offered under a
// bridge anyway (mirrors the group list/detail short-circuit).
export const GET = withAuth(
  async (_req: NextRequest, auth) => {
    if (auth.bridgeCustomerIds !== null) {
      return Response.json({ customers: [] });
    }

    const customers = await withTransaction(getAuthPool(), (client) =>
      listGroupEligibleMembers(client, auth.accountId),
    );

    return Response.json({ customers });
  },
  { ctx: "general" },
);
