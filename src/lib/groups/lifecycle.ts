import type { Pool, PoolClient } from "pg";
import type { ActorContext } from "../audit";
import { auditLog } from "../audit";
import { HttpError } from "../auth/errors";
import { withTransaction } from "../db/client";
import { deleteGroup, fetchMemberStates } from "./groups";

// ---------------------------------------------------------------------------
// Customer-group lifecycle enforcement (#510).
//
// A group must always have a qualifying MANAGER — an operational account
// holding Manager or Analyst on EVERY member. It may never persist
// viewer-only. This module is the shared evaluator that re-derives, from the
// current auth-DB state, the action a group needs:
//
//   - transfer owner — the current `owner_id` stopped qualifying but other
//     qualifying managers remain (deterministic tie-break picks the heir);
//   - auto-delete    — no qualifying manager remains (entity removed here,
//     dedicated database torn down post-commit by the caller);
//   - suspend        — a member is non-operational (paused generation);
//   - resume         — every member is operational again.
//
// It is invoked synchronously from each mutation site that can remove a
// qualifying manager or change member operability, and from the periodic
// sweep backstop (`sweepGroupLifecycle`). Membership/role ADDITIONS are not
// trigger sites: they can only add a qualifying manager (benign), and
// auto-delete is immediate and non-resurrecting.
// ---------------------------------------------------------------------------

export type LifecycleStatus = "active" | "suspended";

/** A candidate heir for ownership, with the fields the tie-break orders on. */
export interface QualifyingManager {
  accountId: string;
  /**
   * `manager` when the account holds the Manager membership role on EVERY
   * member (ranked first, even if it also has analyst assignments);
   * `analyst` when it qualifies but relies on an eligible Analyst
   * assignment for at least one member.
   */
  rank: "manager" | "analyst";
  /**
   * Epoch seconds of the account's earliest qualifying row among the
   * group's members — `account_customer_memberships.created_at` for a
   * Manager candidate, `analyst_customer_assignments.created_at` for an
   * Analyst candidate. The membership-age tie-break orders oldest first.
   */
  ageEpoch: number;
}

interface CoverageRow {
  account_id: string;
  customer_id: string;
  created_epoch: string;
}

/**
 * Ordered list of accounts that qualify as a manager of the group whose
 * members are `memberIds`: an OPERATIONAL account (`accounts.status =
 * 'active'`) holding Manager (membership role) OR Analyst (active
 * assignment gated by `analyst_eligible`) on EVERY member.
 *
 * The result is sorted by the deterministic transfer tie-break:
 *   (1) role rank — Manager before Analyst;
 *   (2) membership age — oldest qualifying row first;
 *   (3) lowest account UUID.
 *
 * An empty member set yields an empty list (a group with no members cannot
 * have a qualifying manager — it auto-deletes).
 */
export async function listQualifyingManagers(
  client: PoolClient,
  memberIds: string[],
): Promise<QualifyingManager[]> {
  if (memberIds.length === 0) return [];

  // Manager-role memberships on the group's members, restricted to
  // operational accounts. `EXTRACT(EPOCH ...)` returns a numeric string for
  // a stable, timezone-independent age comparison.
  const managerRows = await client.query<CoverageRow>(
    `SELECT acm.account_id,
            acm.customer_id,
            EXTRACT(EPOCH FROM acm.created_at)::text AS created_epoch
       FROM account_customer_memberships acm
       JOIN roles r ON r.id = acm.role_id
       JOIN accounts a ON a.id = acm.account_id
      WHERE acm.customer_id = ANY($1::uuid[])
        AND r.name = 'Manager' AND r.auth_context = 'general'
        AND a.status = 'active'`,
    [memberIds],
  );

  // Eligible analyst assignments on the group's members — the same
  // `analyst_eligible` gate `computeMemberAccess` applies.
  const analystRows = await client.query<CoverageRow>(
    `SELECT aca.account_id,
            aca.customer_id,
            EXTRACT(EPOCH FROM aca.created_at)::text AS created_epoch
       FROM analyst_customer_assignments aca
       JOIN accounts a ON a.id = aca.account_id
      WHERE aca.customer_id = ANY($1::uuid[])
        AND a.status = 'active'
        AND a.analyst_eligible = true`,
    [memberIds],
  );

  // account -> (customerId -> epoch) for each grant source.
  const managerBy = new Map<string, Map<string, number>>();
  const analystBy = new Map<string, Map<string, number>>();
  const accumulate = (
    target: Map<string, Map<string, number>>,
    row: CoverageRow,
  ): void => {
    let perCustomer = target.get(row.account_id);
    if (!perCustomer) {
      perCustomer = new Map();
      target.set(row.account_id, perCustomer);
    }
    perCustomer.set(row.customer_id, Number(row.created_epoch));
  };
  for (const row of managerRows.rows) accumulate(managerBy, row);
  for (const row of analystRows.rows) accumulate(analystBy, row);

  const candidates: QualifyingManager[] = [];
  const accountIds = new Set<string>([
    ...managerBy.keys(),
    ...analystBy.keys(),
  ]);
  for (const accountId of accountIds) {
    const mgr = managerBy.get(accountId);
    const ana = analystBy.get(accountId);
    const covers = memberIds.every(
      (id) => (mgr?.has(id) ?? false) || (ana?.has(id) ?? false),
    );
    if (!covers) continue;

    const isManagerRank = memberIds.every((id) => mgr?.has(id) ?? false);
    const ageSource = isManagerRank ? mgr : ana;
    // `ageSource` is non-empty for a covering candidate: a Manager-rank
    // candidate has a Manager row for every member; an Analyst-rank
    // candidate covers at least one member via an analyst assignment.
    const ageEpoch = Math.min(...(ageSource?.values() ?? [Infinity]));
    candidates.push({
      accountId,
      rank: isManagerRank ? "manager" : "analyst",
      ageEpoch,
    });
  }

  candidates.sort((a, b) => {
    if (a.rank !== b.rank) return a.rank === "manager" ? -1 : 1;
    if (a.ageEpoch !== b.ageEpoch) return a.ageEpoch - b.ageEpoch;
    return a.accountId < b.accountId ? -1 : a.accountId > b.accountId ? 1 : 0;
  });
  return candidates;
}

// ---------------------------------------------------------------------------
// Reconcile a single group (transactional — caller supplies the client)
// ---------------------------------------------------------------------------

export interface ReconcileOutcome {
  groupId: string;
  /** False when no group with that id exists (e.g. already deleted). */
  found: boolean;
  /** The group entity was deleted (last qualifying manager gone / no members). */
  deleted: boolean;
  /** Previous owner when ownership was transferred away from it. */
  ownerTransferredFrom?: string;
  /** New owner when ownership transferred. */
  ownerTransferredTo?: string;
  /** New lifecycle status when suspend/resume fired. */
  lifecycleChangedTo?: LifecycleStatus;
}

/**
 * Re-evaluate one group and apply the resolved lifecycle action in the
 * caller's transaction. Returns what changed so the caller can tear the
 * dedicated database down post-commit when `deleted` is true.
 *
 * The group row is locked `FOR UPDATE` so concurrent reconciles (e.g. a
 * mutation hook racing the sweep) serialize on it.
 */
export async function reconcileGroup(
  client: PoolClient,
  groupId: string,
  actorContext?: ActorContext,
): Promise<ReconcileOutcome> {
  const groupRows = await client.query<{
    owner_id: string;
    lifecycle_status: LifecycleStatus;
  }>(
    `SELECT owner_id, lifecycle_status FROM customer_groups
      WHERE id = $1 FOR UPDATE`,
    [groupId],
  );
  if (groupRows.rows.length === 0) {
    return { groupId, found: false, deleted: false };
  }
  const { owner_id: ownerId, lifecycle_status: current } = groupRows.rows[0];

  const memberRows = await client.query<{ customer_id: string }>(
    `SELECT customer_id FROM customer_group_members WHERE group_id = $1`,
    [groupId],
  );
  const memberIds = memberRows.rows.map((r) => r.customer_id);

  const qualifying = await listQualifyingManagers(client, memberIds);

  // Auto-delete: no operational Manager/Analyst-on-all account remains (a
  // viewer-only group is not allowed to exist), or the member set is empty.
  if (qualifying.length === 0) {
    await deleteGroup(client, groupId);
    if (actorContext) {
      // Awaited (not fire-and-forget): this row carries the member ids, and
      // `reconcileGroups` runs the dedicated DB teardown — whose
      // `anonymizeGroupAuditLogs` scrubs `audit_logs WHERE target_id = $1` —
      // AFTER this transaction commits. Awaiting guarantees the row exists
      // before that scrub, mirroring the manual group DELETE path. auditLog()
      // still swallows audit-DB errors, so this stays best-effort.
      await auditLog({
        actorId: actorContext.actorId,
        authContext: actorContext.authContext,
        action: "customer_group.auto_deleted",
        targetType: "customer_group",
        targetId: groupId,
        details: { reason: "no_qualifying_manager", memberIds },
        ipAddress: actorContext.ipAddress,
        sid: actorContext.sid,
      });
    }
    return { groupId, found: true, deleted: true };
  }

  const outcome: ReconcileOutcome = { groupId, found: true, deleted: false };

  // Owner transfer: the current owner stopped qualifying; hand ownership to
  // the deterministic heir among the remaining qualifying managers.
  const ownerQualifies = qualifying.some((q) => q.accountId === ownerId);
  if (!ownerQualifies) {
    const heir = qualifying[0].accountId;
    await client.query(
      `UPDATE customer_groups SET owner_id = $2, updated_at = NOW()
        WHERE id = $1`,
      [groupId, heir],
    );
    outcome.ownerTransferredFrom = ownerId;
    outcome.ownerTransferredTo = heir;
    if (actorContext) {
      void auditLog({
        actorId: actorContext.actorId,
        authContext: actorContext.authContext,
        action: "customer_group.owner_transferred",
        targetType: "customer_group",
        targetId: groupId,
        details: { from: ownerId, to: heir },
        ipAddress: actorContext.ipAddress,
        sid: actorContext.sid,
      });
    }
  }

  // Suspend / resume: pause generation while any member is non-operational;
  // resume only when every member is fully operational again. A member in a
  // transient state (e.g. `database_status = 'provisioning'`) is neither —
  // the status is left unchanged until it settles.
  const members = await fetchMemberStates(client, memberIds);
  const suspendCond = members.some(
    (m) =>
      m.status === "suspended" ||
      m.status === "disabled" ||
      m.databaseStatus === "failed",
  );
  const resumeCond =
    members.length > 0 &&
    members.every(
      (m) => m.status === "active" && m.databaseStatus === "active",
    );
  const desired: LifecycleStatus | null = suspendCond
    ? "suspended"
    : resumeCond
      ? "active"
      : null;
  if (desired !== null && desired !== current) {
    await client.query(
      `UPDATE customer_groups SET lifecycle_status = $2, updated_at = NOW()
        WHERE id = $1`,
      [groupId, desired],
    );
    outcome.lifecycleChangedTo = desired;
    if (actorContext) {
      void auditLog({
        actorId: actorContext.actorId,
        authContext: actorContext.authContext,
        action:
          desired === "suspended"
            ? "customer_group.suspended"
            : "customer_group.resumed",
        targetType: "customer_group",
        targetId: groupId,
        details: { from: current, to: desired },
        ipAddress: actorContext.ipAddress,
        sid: actorContext.sid,
      });
    }
  }

  return outcome;
}

// ---------------------------------------------------------------------------
// Affected-group finders
// ---------------------------------------------------------------------------

/** Group ids the customer is a member of. */
export async function groupIdsContainingCustomer(
  client: PoolClient,
  customerId: string,
): Promise<string[]> {
  const { rows } = await client.query<{ group_id: string }>(
    `SELECT group_id FROM customer_group_members WHERE customer_id = $1`,
    [customerId],
  );
  return rows.map((r) => r.group_id);
}

/**
 * Group ids whose lifecycle an account's state could change: groups it owns,
 * plus groups where it holds a membership or analyst assignment on a member
 * (so revoking a role/eligibility or suspending the account is re-evaluated).
 */
export async function groupIdsAffectedByAccount(
  client: PoolClient,
  accountId: string,
): Promise<string[]> {
  const { rows } = await client.query<{ id: string }>(
    `SELECT DISTINCT cg.id
       FROM customer_groups cg
      WHERE cg.owner_id = $1
         OR EXISTS (
              SELECT 1 FROM customer_group_members m
              JOIN account_customer_memberships acm
                ON acm.customer_id = m.customer_id AND acm.account_id = $1
             WHERE m.group_id = cg.id)
         OR EXISTS (
              SELECT 1 FROM customer_group_members m
              JOIN analyst_customer_assignments aca
                ON aca.customer_id = m.customer_id AND aca.account_id = $1
             WHERE m.group_id = cg.id)`,
    [accountId],
  );
  return rows.map((r) => r.id);
}

/** Every group id (sweep backstop). */
export async function allGroupIds(client: PoolClient): Promise<string[]> {
  const { rows } = await client.query<{ id: string }>(
    `SELECT id FROM customer_groups ORDER BY created_at`,
  );
  return rows.map((r) => r.id);
}

// ---------------------------------------------------------------------------
// Orchestration: reconcile a set of groups + tear down the auto-deleted ones
// ---------------------------------------------------------------------------

export interface ReconcileGroupsOptions {
  actorContext?: ActorContext;
  /**
   * Post-commit teardown of an auto-deleted group's dedicated database.
   * Defaults to the real `teardownGroupDb`; injectable for tests.
   */
  teardown?: (groupId: string, actorContext?: ActorContext) => Promise<void>;
}

async function defaultTeardown(
  groupId: string,
  actorContext?: ActorContext,
): Promise<void> {
  // Dynamic imports keep this module usable from plain Node tooling (the
  // migration CLI) without eagerly pulling `server-only`-tagged code.
  const [{ teardownGroupDb }, { getMigrationAuditPool }] = await Promise.all([
    import("../db/teardown-group"),
    import("../db/client"),
  ]);
  await teardownGroupDb(getMigrationAuditPool(), groupId, actorContext);
}

/**
 * Reconcile each group in its own transaction, tearing down the dedicated
 * database of an auto-deleted group immediately after that group's delete
 * commits (best-effort, post-commit — mirroring the group DELETE path).
 *
 * Teardown is coupled to each committed delete rather than batched after the
 * whole loop: once a group's delete commits, its auth row is gone, so a
 * failure on a LATER group must not exit before its database is reclaimed —
 * `sweepGroupLifecycle` could no longer rediscover it to clean up, stranding
 * an orphaned provisioned database. A teardown failure never blocks the
 * reconcile; the sweep converges any leftover state.
 */
export async function reconcileGroups(
  authPool: Pool,
  groupIds: string[],
  options: ReconcileGroupsOptions = {},
): Promise<ReconcileOutcome[]> {
  const teardown = options.teardown ?? defaultTeardown;
  const outcomes: ReconcileOutcome[] = [];
  for (const groupId of groupIds) {
    const outcome = await withTransaction(authPool, (client) =>
      reconcileGroup(client, groupId, options.actorContext),
    );
    outcomes.push(outcome);
    if (outcome.deleted) {
      try {
        await teardown(outcome.groupId, options.actorContext);
      } catch (err) {
        console.error(
          `Failed to tear down auto-deleted group ${outcome.groupId}:`,
          (err as Error).message,
        );
      }
    }
  }
  return outcomes;
}

async function findGroupIds(
  authPool: Pool,
  finder: (client: PoolClient) => Promise<string[]>,
): Promise<string[]> {
  const client = await authPool.connect();
  try {
    return await finder(client);
  } finally {
    client.release();
  }
}

/** Reconcile every group the customer belongs to (member-state change). */
export async function reconcileGroupsForCustomer(
  authPool: Pool,
  customerId: string,
  options: ReconcileGroupsOptions = {},
): Promise<ReconcileOutcome[]> {
  const ids = await findGroupIds(authPool, (c) =>
    groupIdsContainingCustomer(c, customerId),
  );
  if (ids.length === 0) return [];
  return reconcileGroups(authPool, ids, options);
}

/** Reconcile every group an account's state could affect (role/eligibility/status). */
export async function reconcileGroupsForAccount(
  authPool: Pool,
  accountId: string,
  options: ReconcileGroupsOptions = {},
): Promise<ReconcileOutcome[]> {
  const ids = await findGroupIds(authPool, (c) =>
    groupIdsAffectedByAccount(c, accountId),
  );
  if (ids.length === 0) return [];
  return reconcileGroups(authPool, ids, options);
}

/** Periodic backstop: reconcile every group. */
export async function sweepGroupLifecycle(
  authPool: Pool,
  options: ReconcileGroupsOptions = {},
): Promise<ReconcileOutcome[]> {
  const ids = await findGroupIds(authPool, allGroupIds);
  return reconcileGroups(authPool, ids, options);
}

// ---------------------------------------------------------------------------
// Generation guard (consumed by the #508 pipeline / group-report endpoints)
// ---------------------------------------------------------------------------

/** The group's lifecycle status, or `null` when no such group exists. */
export async function getGroupLifecycleStatus(
  client: PoolClient,
  groupId: string,
): Promise<LifecycleStatus | null> {
  const { rows } = await client.query<{ lifecycle_status: LifecycleStatus }>(
    `SELECT lifecycle_status FROM customer_groups WHERE id = $1`,
    [groupId],
  );
  return rows[0]?.lifecycle_status ?? null;
}

/**
 * Assert that a group's report generation is allowed to run. Throws
 * `HttpError(404)` when the group is gone and `HttpError(409,
 * "group_generation_suspended")` while it is suspended — the reusable gate
 * group-report WRITE / regeneration endpoints (scheduled generation and any
 * manual regenerate/refresh) call to stay read-only during suspension.
 */
export async function assertGroupGenerationActive(
  client: PoolClient,
  groupId: string,
): Promise<void> {
  const status = await getGroupLifecycleStatus(client, groupId);
  if (status === null) throw new HttpError("Group not found", 404);
  if (status !== "active") {
    throw new HttpError("group_generation_suspended", 409);
  }
}
