import type { PoolClient } from "pg";

// ---------------------------------------------------------------------------
// Customer-group entity persistence (#506).
//
// A group is a `kind='group'` subject (RFC 0004 / #503) sharing its UUID
// with its supertype row. Like `createCustomer`, the create path inserts
// the `subjects` row first, in the same transaction. Membership is
// immutable (create is the only writer); there is no add/remove path.
//
// The per-group retention policy and group rows all live in the auth DB —
// this module never touches a group data DB (#507 provisions that later).
// ---------------------------------------------------------------------------

export interface MemberState {
  id: string;
  status: string;
  databaseStatus: string;
  timezone: string;
}

export interface CreateGroupParams {
  name: string;
  description: string | null;
  /** Unique customer ids (>= 2), already validated operational by caller. */
  memberIds: string[];
  /** Resolved, IANA-valid bucket timezone. */
  tz: string;
  /** Creator account — set as both `created_by` and the initial `owner_id`. */
  creatorAccountId: string;
  /** Default group analysis-retention (days); null = no expiry. */
  analysisDays: number | null;
}

export interface GroupRow {
  id: string;
  name: string;
  description: string | null;
  ownerId: string;
  createdBy: string;
  createdAt: string;
  tz: string;
}

export interface CreatedGroup extends GroupRow {
  memberIds: string[];
}

// ---------------------------------------------------------------------------
// Member-state lookup (existence + operational eligibility + tz)
// ---------------------------------------------------------------------------

/**
 * Fetch `(status, database_status, timezone)` for the given customer ids.
 * Ids that do not exist are simply absent from the result — the caller
 * compares the returned count against the requested ids to detect
 * missing members.
 */
export async function fetchMemberStates(
  client: PoolClient,
  memberIds: string[],
): Promise<MemberState[]> {
  if (memberIds.length === 0) return [];
  const { rows } = await client.query<{
    id: string;
    status: string;
    database_status: string;
    timezone: string;
  }>(
    `SELECT id, status, database_status, timezone
       FROM customers
      WHERE id = ANY($1::uuid[])`,
    [memberIds],
  );
  return rows.map((r) => ({
    id: r.id,
    status: r.status,
    databaseStatus: r.database_status,
    timezone: r.timezone,
  }));
}

// ---------------------------------------------------------------------------
// Create (transactional — caller supplies the client/transaction)
// ---------------------------------------------------------------------------

export async function createGroup(
  client: PoolClient,
  params: CreateGroupParams,
): Promise<CreatedGroup> {
  // Insert the supertype row first so the composite FK
  // `(id, kind) -> subjects(id, kind)` is satisfiable, then reuse the id.
  const subj = await client.query<{ id: string }>(
    `INSERT INTO subjects (kind) VALUES ('group') RETURNING id`,
  );
  const groupId = subj.rows[0].id;

  const grp = await client.query<{ created_at: string }>(
    `INSERT INTO customer_groups
       (id, kind, name, description, created_by, owner_id, tz)
     VALUES ($1, 'group', $2, $3, $4, $4, $5)
     RETURNING created_at`,
    [
      groupId,
      params.name,
      params.description,
      params.creatorAccountId,
      params.tz,
    ],
  );

  // Bulk-insert the (immutable) membership rows.
  await client.query(
    `INSERT INTO customer_group_members (group_id, customer_id)
     SELECT $1, unnest($2::uuid[])`,
    [groupId, params.memberIds],
  );

  // Auto-insert the auth-DB retention-policy row (peer of
  // customer_retention_policy). Absence is treated as a bug downstream.
  await client.query(
    `INSERT INTO group_retention_policy (subject_id, analysis_days, updated_by)
     VALUES ($1, $2, $3)`,
    [groupId, params.analysisDays, params.creatorAccountId],
  );

  return {
    id: groupId,
    name: params.name,
    description: params.description,
    ownerId: params.creatorAccountId,
    createdBy: params.creatorAccountId,
    createdAt: grp.rows[0].created_at,
    tz: params.tz,
    memberIds: params.memberIds,
  };
}

// ---------------------------------------------------------------------------
// Read group + members (for authorization + 404 detection)
// ---------------------------------------------------------------------------

/**
 * Load a group's row and its member customer ids, or `null` if no group
 * with that id exists. Member ids are needed by every group endpoint to
 * evaluate the all-member management predicate.
 */
export async function getGroupWithMembers(
  client: PoolClient,
  groupId: string,
): Promise<{ group: GroupRow; memberIds: string[] } | null> {
  const { rows } = await client.query<{
    id: string;
    name: string;
    description: string | null;
    owner_id: string;
    created_by: string;
    created_at: string;
    tz: string;
  }>(
    `SELECT id, name, description, owner_id, created_by, created_at, tz
       FROM customer_groups
      WHERE id = $1`,
    [groupId],
  );
  if (rows.length === 0) return null;
  const r = rows[0];

  const memberRows = await client.query<{ customer_id: string }>(
    `SELECT customer_id FROM customer_group_members
      WHERE group_id = $1
      ORDER BY customer_id`,
    [groupId],
  );

  return {
    group: {
      id: r.id,
      name: r.name,
      description: r.description,
      ownerId: r.owner_id,
      createdBy: r.created_by,
      createdAt: r.created_at,
      tz: r.tz,
    },
    memberIds: memberRows.rows.map((m) => m.customer_id),
  };
}

// ---------------------------------------------------------------------------
// Delete (entity-level)
// ---------------------------------------------------------------------------

/**
 * Delete the group entity by removing its `subjects (kind='group')` row.
 * The composite FK cascades `customer_groups`, which cascades
 * `customer_group_members`; the `group_retention_policy.subject_id` FK
 * cascades the policy row — so no orphan policy survives. Returns whether
 * a group row was actually removed.
 *
 * Tearing down the group's dedicated data DB is layered by #507 / #510;
 * at #506 the data DB may not exist yet.
 */
export async function deleteGroup(
  client: PoolClient,
  groupId: string,
): Promise<boolean> {
  const res = await client.query(
    `DELETE FROM subjects WHERE id = $1 AND kind = 'group' RETURNING id`,
    [groupId],
  );
  return (res.rowCount ?? 0) > 0;
}

// ---------------------------------------------------------------------------
// Retention policy (read / update)
// ---------------------------------------------------------------------------

/**
 * The group's `analysis_days` (exposed by the API as `groupPolicyDays`),
 * or `null` when the policy is "no expiry". Throws nothing for a missing
 * row — returns `undefined` so the caller can 404.
 */
export async function getGroupRetention(
  client: PoolClient,
  groupId: string,
): Promise<{ analysisDays: number | null } | undefined> {
  const { rows } = await client.query<{ analysis_days: number | null }>(
    `SELECT analysis_days FROM group_retention_policy WHERE subject_id = $1`,
    [groupId],
  );
  if (rows.length === 0) return undefined;
  return { analysisDays: rows[0].analysis_days };
}

export interface RetentionUpdate {
  before: number | null;
  after: number | null;
  changed: boolean;
}

export async function updateGroupRetention(
  client: PoolClient,
  groupId: string,
  analysisDays: number | null,
  updatedBy: string,
): Promise<RetentionUpdate | undefined> {
  const cur = await client.query<{ analysis_days: number | null }>(
    `SELECT analysis_days FROM group_retention_policy WHERE subject_id = $1`,
    [groupId],
  );
  if (cur.rows.length === 0) return undefined;
  const before = cur.rows[0].analysis_days;
  const changed = before !== analysisDays;
  if (changed) {
    await client.query(
      `UPDATE group_retention_policy
          SET analysis_days = $2, updated_at = NOW(), updated_by = $3
        WHERE subject_id = $1`,
      [groupId, analysisDays, updatedBy],
    );
  }
  return { before, after: analysisDays, changed };
}

// ---------------------------------------------------------------------------
// Timezone (re-set; future buckets only)
// ---------------------------------------------------------------------------

export interface TimezoneUpdate {
  before: string;
  after: string;
  changed: boolean;
}

/**
 * Re-set the group's bucket `tz`. This affects only FUTURE buckets — past
 * `periodic_report_state` rows keep the `tz` in their bucket key (the tz
 * is part of that PK), so this update never rewrites them.
 */
export async function updateGroupTimezone(
  client: PoolClient,
  groupId: string,
  tz: string,
): Promise<TimezoneUpdate | undefined> {
  const cur = await client.query<{ tz: string }>(
    `SELECT tz FROM customer_groups WHERE id = $1`,
    [groupId],
  );
  if (cur.rows.length === 0) return undefined;
  const before = cur.rows[0].tz;
  const changed = before !== tz;
  if (changed) {
    await client.query(
      `UPDATE customer_groups SET tz = $2, updated_at = NOW() WHERE id = $1`,
      [groupId, tz],
    );
  }
  return { before, after: tz, changed };
}
