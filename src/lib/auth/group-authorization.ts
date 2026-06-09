import type { PoolClient } from "pg";
import { listGroupsWithMembers } from "@/lib/groups/groups";
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

/**
 * Three-way authorization outcome for a group read surface, preserving the
 * single-customer loaders' existence-hiding contract (#525):
 *
 *   - `"authorized"` — the account holds `permission` on EVERY member;
 *   - `"forbidden"` — the account is a member of (has a membership/eligible-
 *     analyst relationship with) every member customer but is MISSING
 *     `permission` on at least one → 403;
 *   - `"not_found"` — the account has NO relationship with at least one member
 *     customer → 404, so a non-member cannot even learn the group (or its
 *     member list) exists.
 *
 * Mirrors the per-customer mapping `authorizeGeneral` drives (member-without-
 * permission → 403, non-member → 404), lifted to "every member". Built on the
 * same `computeMemberAccess` grant union as {@link hasAllMemberReadPermission}
 * (membership ∪ `analyst_eligible`-gated analyst), computed once. An empty
 * member list is `"not_found"` (a group with no members reveals nothing).
 */
export type GroupReadOutcome = "authorized" | "forbidden" | "not_found";

export async function resolveGroupReadOutcome(
  client: PoolClient,
  accountId: string,
  memberCustomerIds: string[],
  permission: string,
): Promise<GroupReadOutcome> {
  if (memberCustomerIds.length === 0) return "not_found";
  const access = await computeMemberAccess(
    client,
    accountId,
    memberCustomerIds,
  );
  // Non-member of any single customer hides the whole group (existence-
  // hiding): the account is absent from the access map for that customer.
  if (!memberCustomerIds.every((id) => access.has(id))) return "not_found";
  // Member of every customer, but missing the read permission on one → 403.
  if (
    !memberCustomerIds.every(
      (id) => access.get(id)?.permissions.has(permission) ?? false,
    )
  ) {
    return "forbidden";
  }
  return "authorized";
}

// ---------------------------------------------------------------------------
// Account-accessible group listing (#513)
// ---------------------------------------------------------------------------

/**
 * One group the account may surface as a summary subject: the entity fields
 * plus its ordered member customer ids and bucket timezone. Drives the sidebar
 * group navigation and the scope-filter presets (#513). `memberIds` is carried
 * so a scope preset can expand the group into its members client-side without a
 * second round-trip.
 */
export interface AccessibleGroup {
  id: string;
  name: string;
  description: string | null;
  memberIds: string[];
  tz: string;
}

/**
 * List the groups `accountId` may VIEW: in v1 (reports-only) "can view" means
 * the account holds `reports:read` on EVERY member customer — the same
 * all-member union `resolveGroupReadOutcome` enforces, lifted to a list. A
 * group inaccessible on even one member is dropped (existence-hiding), so a
 * non-member never learns the group exists.
 *
 * Computed in two steps without per-group fan-out: load every group with its
 * members, then resolve the viewer's per-customer access over the UNION of all
 * member ids in a single `computeMemberAccess` call, and keep the groups whose
 * every member carries `reports:read`. A member-less group never qualifies (an
 * empty `every` would be vacuously true, but a group with no members reveals
 * nothing — mirrors `resolveGroupReadOutcome`'s empty → not_found).
 *
 * Bridge handling is the caller's: the `GET /api/auth/groups` route
 * short-circuits a bridge session to `{ groups: [] }` BEFORE calling this, the
 * same short-circuit the other surfaces apply — this function adds no
 * bridge-specific logic.
 */
export async function listAccessibleGroups(
  client: PoolClient,
  accountId: string,
): Promise<AccessibleGroup[]> {
  const groups = await listGroupsWithMembers(client);
  if (groups.length === 0) return [];

  const allMemberIds = [...new Set(groups.flatMap((g) => g.memberIds))];
  const access = await computeMemberAccess(client, accountId, allMemberIds);

  const visible: AccessibleGroup[] = [];
  for (const { group, memberIds } of groups) {
    if (memberIds.length === 0) continue;
    const readable = memberIds.every(
      (id) => access.get(id)?.permissions.has("reports:read") ?? false,
    );
    if (!readable) continue;
    visible.push({
      id: group.id,
      name: group.name,
      description: group.description,
      memberIds,
      tz: group.tz,
    });
  }
  return visible;
}
