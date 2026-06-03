// Shared server-side auth preamble for single-customer read surfaces
// (WS3 #392 — customer hub + Threat Stories / Suspicious Events lists).
//
// The existing story/event detail loaders collapse every denial to a single
// "unauthorized" (→ 404). The report-index loader instead distinguishes
// bridge denial (`reason === "bridge_not_allowed"` → 403),
// member-without-permission (`permissions !== undefined` → 403) and
// non-membership / non-existent customer (→ 404, existence-hiding). The WS3
// surfaces require that richer mapping, so it is implemented here once and
// shared — it is NOT inherited from the detail loaders.
//
// This helper returns the member's full permission set (when they are a
// member at all) so callers can apply their own per-section policy: the
// list loaders require `analyses:read`; the hub renders the reports section
// on `reports:read` and the stories/events sections on `analyses:read`,
// showing only the permitted subset.

import "server-only";

import { authorize } from "@/lib/auth/authorization";
import { getAuthCookie } from "@/lib/auth/cookies";
import { verifyJwtFull } from "@/lib/auth/jwt";
import { getSessionPolicy } from "@/lib/auth/session-policy";
import { validateSession } from "@/lib/auth/session-validator";
import { getAuthPool, withTransaction } from "@/lib/db/client";

export type CustomerReadAccess =
  | { kind: "unauthorized" }
  | { kind: "forbidden" }
  | { kind: "ok"; permissions: Set<string> };

/**
 * Resolve the caller's read access to a single customer. On success returns
 * the member's permission set (which may lack any given analysis/report
 * permission — the caller decides what to do with a partial set).
 *
 * Mapping (mirrors `report-index-page-loader.ts`):
 *   - missing/invalid session → `unauthorized`
 *   - in-scope bridge session → `forbidden` (bridge cannot read these
 *     surfaces)
 *   - member (with or without a specific permission) → `ok` + permissions
 *   - non-member / non-existent / inactive customer → `unauthorized`
 */
export async function resolveCustomerReadAccess(
  customerId: string,
): Promise<CustomerReadAccess> {
  const token = await getAuthCookie("general");
  if (!token) return { kind: "unauthorized" };
  let claims: Awaited<ReturnType<typeof verifyJwtFull>>;
  try {
    claims = await verifyJwtFull(token, "general");
  } catch {
    return { kind: "unauthorized" };
  }

  const authPool = getAuthPool();

  let bridgeAiceId: string | null = null;
  let bridgeCustomerIds: string[] | null = null;
  try {
    const policy = await getSessionPolicy();
    const session = await validateSession(authPool, claims.sid, policy.general);
    bridgeAiceId = session.bridgeAiceId;
    bridgeCustomerIds = session.bridgeCustomerIds;
  } catch {
    return { kind: "unauthorized" };
  }

  // The required-permission argument only drives `authorize`'s `authorized`
  // boolean, which we ignore — we read the returned `permissions` set
  // directly. `allowInBridge: false` makes an in-scope bridge session a
  // `bridge_not_allowed` denial, mirroring the report-index / detail
  // surfaces.
  const auth = await withTransaction(authPool, (client) =>
    authorize(client, "general", claims.sub, "analyses:read", {
      customerId,
      operationKind: "read",
      allowInBridge: false,
      bridgeScope: bridgeCustomerIds
        ? { aiceId: bridgeAiceId ?? "", customerIds: bridgeCustomerIds }
        : null,
    }),
  );

  if (auth.reason === "bridge_not_allowed") return { kind: "forbidden" };
  // `authorizeGeneral` returns a `permissions` set for any member (even one
  // without the queried permission) and leaves it undefined for non-members
  // / inactive / non-existent customers.
  if (auth.permissions === undefined) return { kind: "unauthorized" };
  return { kind: "ok", permissions: auth.permissions };
}
