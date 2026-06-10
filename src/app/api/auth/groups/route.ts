import type { NextRequest } from "next/server";
import { listAccessibleGroups } from "@/lib/auth/group-authorization";
import { withAuth } from "@/lib/auth/guards";
import { getAuthPool, withTransaction } from "@/lib/db/client";

// GET /api/auth/groups — the customer groups the account can surface as
// summary subjects (#513). "Can view" in v1 (reports-only) means the viewer
// holds `reports:read` on EVERY member; a group inaccessible on even one
// member is omitted (existence-hiding).
//
// Bridge sessions get `{ groups: [] }` — the same short-circuit the other
// group surfaces apply, not new bridge logic: group reads stay denied under a
// bridge, so the sidebar and scope presets render no groups with no
// group-specific branch. Mirrors how `/api/auth/customers` is bridge-scoped,
// but here the restriction collapses the whole list to empty.
export const GET = withAuth(async (_req: NextRequest, auth) => {
  if (auth.bridgeCustomerIds !== null) {
    return Response.json({ groups: [] });
  }

  const groups = await withTransaction(getAuthPool(), (client) =>
    listAccessibleGroups(client, auth.accountId),
  );

  return Response.json({ groups });
});
