import "server-only";

import type { Pool } from "pg";
import { getGroupWithMembers } from "../groups/groups";
import { getCustomerRuntimePool } from "./customer-runtime-pool";
import { getGroupRuntimePool } from "./group-runtime-pool";

// ---------------------------------------------------------------------------
// Subject runtime resolution (#523).
//
// A periodic report is keyed by a `subject_id`, which is either a
// `kind='customer'` subject (its result DB is the per-customer DB) or a
// `kind='group'` subject (its result DB is the group's dedicated data DB,
// and its analyzed leaves live in the MEMBER customer DBs). This layer maps a
// `subject_id` to the pools the pipeline needs:
//
//   (a) the RESULT DB pool — where `periodic_report_result` rows are written /
//       read: `getCustomerRuntimePool` for a customer, `getGroupRuntimePool`
//       for a group;
//   (b) for a group, the ordered MEMBER pools — the member id list comes from
//       `customer_group_members` (via `getGroupWithMembers`), each opened with
//       `getCustomerRuntimePool`.
//
// This is the seam steps #524 (multi-member generation) and #525 (display
// fan-out) build on. This issue only introduces the seam and routes the
// existing single-customer worker path through it (the customer branch is
// behavior-identical to the prior direct `getCustomerRuntimePool` call); it
// does NOT open group end-to-end generation.
// ---------------------------------------------------------------------------

export type SubjectKind = "customer" | "group";

/**
 * Read a subject's `kind` from the auth DB `subjects` table, or `null` when no
 * subject with that id exists. A lightweight lookup for surfaces that must
 * branch by kind WITHOUT resolving the (heavier) member pools — e.g. the hub
 * page dispatching a customer vs group loader (#513). Every customer is a
 * `kind='customer'` subject sharing its UUID (#503), so a customer id resolves
 * to `"customer"` here.
 */
export async function getSubjectKind(
  authPool: Pool,
  subjectId: string,
): Promise<SubjectKind | null> {
  const { rows } = await authPool.query<{ kind: SubjectKind }>(
    `SELECT kind FROM subjects WHERE id = $1`,
    [subjectId],
  );
  return rows[0]?.kind ?? null;
}

/** One resolved member customer pool, in `customer_group_members` order. */
export interface MemberPool {
  /** The member subject id (the customer id). */
  customerId: string;
  pool: Pool;
}

export interface SubjectPools {
  kind: SubjectKind;
  /**
   * The result DB pool — the customer DB for a `customer` subject, the group
   * DB for a `group` subject. `periodic_report_result` rows live here.
   */
  resultPool: Pool;
  /**
   * Ordered member customer pools for a `group` subject (empty for a
   * `customer` subject). Groups generate from these member DBs (#524).
   */
  memberPools: MemberPool[];
}

/** Pool factories, overridable for tests. */
export interface ResolveSubjectPoolsDeps {
  getCustomerPool?: (customerId: string) => Pool;
  getGroupPool?: (groupId: string) => Pool;
}

/**
 * Resolve a `subject_id` to its result pool (and, for a group, its ordered
 * member pools). Reads the subject `kind` from the auth DB `subjects` table.
 * Throws on an unknown subject (no `subjects` row) or a group with no
 * `customer_groups` row — both are integrity failures, not normal absences.
 */
export async function resolveSubjectPools(
  authPool: Pool,
  subjectId: string,
  deps: ResolveSubjectPoolsDeps = {},
): Promise<SubjectPools> {
  const getCustomerPool = deps.getCustomerPool ?? getCustomerRuntimePool;
  const getGroupPool = deps.getGroupPool ?? getGroupRuntimePool;

  const { rows } = await authPool.query<{ kind: SubjectKind }>(
    `SELECT kind FROM subjects WHERE id = $1`,
    [subjectId],
  );
  if (rows.length === 0) {
    throw new Error(`unknown subject ${subjectId}`);
  }
  const kind = rows[0].kind;

  if (kind === "customer") {
    return {
      kind,
      resultPool: getCustomerPool(subjectId),
      memberPools: [],
    };
  }

  // Group: the result DB is the group's dedicated data DB; the analyzed
  // leaves it will cite (#524) live in the member customer DBs, resolved in
  // `customer_group_members` order so the combined leaf set — and the
  // report-scope `R{j}` token numbering over it — is deterministic.
  const client = await authPool.connect();
  let memberIds: string[];
  try {
    const groupWithMembers = await getGroupWithMembers(client, subjectId);
    if (groupWithMembers === null) {
      throw new Error(`group subject ${subjectId} has no group row`);
    }
    memberIds = groupWithMembers.memberIds;
  } finally {
    client.release();
  }

  return {
    kind,
    resultPool: getGroupPool(subjectId),
    memberPools: memberIds.map((customerId) => ({
      customerId,
      pool: getCustomerPool(customerId),
    })),
  };
}
