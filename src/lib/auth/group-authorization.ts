import type { PoolClient } from "pg";
import { computeMemberAccess } from "./authorization";
import { HttpError } from "./errors";

// ---------------------------------------------------------------------------
// All-member group authorization predicates (#506)
//
// Customer groups are gated by predicates that must hold for EVERY member
// customer. The single-permission `assertAuthorized(..., perm, ...)` check
// cannot express "Manager OR Analyst on every member" (Analyst has no
// management :write key), so these helpers exist.
//
// Both build on the shared `computeMemberAccess` grant computation, so the
// `analyst_eligible` gate is always applied — a stale analyst assignment on
// an ineligible account never qualifies. They stay SEPARATE (management
// predicate vs read-permission helper) but share that inner query.
// ---------------------------------------------------------------------------

/**
 * Whether `accountId` holds the all-member MANAGEMENT predicate over
 * `memberCustomerIds`: **Manager** (membership role) OR **Analyst**
 * (active assignment gated by `analyst_eligible`) on EVERY member
 * customer. System Administrator is not involved (general context only).
 *
 * This is the binding membership-define gate and subsumes "members ⊆
 * creator's accessible customers" (holding Manager/Analyst on a customer
 * implies access to it). It gates create, delete (interim, until #510
 * narrows to owner-only), retention-update, and timezone-update.
 *
 * An empty member list returns `false`: there is nothing to manage, and
 * a vacuous `true` would be a foot-gun for a caller that forgot to
 * populate the list.
 */
export async function hasAllMemberManagement(
  client: PoolClient,
  accountId: string,
  memberCustomerIds: string[],
): Promise<boolean> {
  if (memberCustomerIds.length === 0) return false;
  const access = await computeMemberAccess(
    client,
    accountId,
    memberCustomerIds,
  );
  return memberCustomerIds.every((id) => {
    const a = access.get(id);
    return a !== undefined && (a.role === "Manager" || a.isAnalyst);
  });
}

/**
 * Assert the all-member management predicate, throwing `HttpError(403)`
 * when it does not hold.
 */
export async function assertAllMemberManagement(
  client: PoolClient,
  accountId: string,
  memberCustomerIds: string[],
): Promise<void> {
  const ok = await hasAllMemberManagement(client, accountId, memberCustomerIds);
  if (!ok) {
    throw new HttpError("Forbidden", 403);
  }
}

/**
 * Assert that `accountId` is the group's current `owner_id`, throwing
 * `HttpError(403)` otherwise. This is the owner-only gate #510 narrows the
 * group DELETE and retry-provision endpoints to (the management predicate
 * still gates retention and timezone). The lifecycle evaluator keeps the
 * owner a qualifying manager at all times, so owner identity alone is a
 * sufficient gate here.
 */
export function assertGroupOwner(ownerId: string, accountId: string): void {
  if (ownerId !== accountId) {
    throw new HttpError("Forbidden", 403);
  }
}

/**
 * Whether `accountId` holds `permission` (a per-surface read permission,
 * e.g. `"reports:read"` / `"analyses:read"`) on EVERY member customer,
 * using the same membership ∪ analyst(`analyst_eligible`-gated) grant
 * union as `authorizeGeneral`.
 *
 * The group report / story / event view surfaces do not exist yet (they
 * land in #508 / #513), so this issue ships the reusable helper for those
 * issues to consume rather than wiring it onto a real surface. An empty
 * member list returns `false`.
 */
export async function hasAllMemberReadPermission(
  client: PoolClient,
  accountId: string,
  memberCustomerIds: string[],
  permission: string,
): Promise<boolean> {
  if (memberCustomerIds.length === 0) return false;
  const access = await computeMemberAccess(
    client,
    accountId,
    memberCustomerIds,
  );
  return memberCustomerIds.every(
    (id) => access.get(id)?.permissions.has(permission) ?? false,
  );
}
