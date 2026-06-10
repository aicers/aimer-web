import type { PoolClient } from "pg";

// ---------------------------------------------------------------------------
// Group-eligible member source (#512).
//
// The create-group member picker needs the creator's accessible customers
// narrowed to the ones that can actually back a group, plus the timezone that
// drives the client-side auto-fill / recommendation. The view-scoped
// `/api/auth/customers` source (`listAccessibleCustomersDetailed`) filters on
// `status = 'active'` only and exposes neither `database_status` nor
// `timezone`, and it feeds shared global context (the sidebar scope selector),
// so it must keep that filter unchanged. Rather than widen it, this dedicated
// source narrows to the group-eligible set:
//
//   - MANAGEABLE: the caller holds **Manager** (membership role) OR an eligible
//     **Analyst** assignment (gated by `analyst_eligible`) — the same union
//     `assertAllMemberManagement` enforces per member, so a customer the caller
//     can only view (role "User") never appears.
//   - OPERATIONAL: `status = 'active'` AND `database_status = 'active'` — the
//     same operational predicate `validateGroupMembers` enforces server-side.
//
// This is a UX pre-filter, not the security boundary: the authoritative
// permission / cap / operational checks still run in `validateGroupMembers`
// and the preview route. Keeping the operational filter contained here avoids
// leaking it into the shared `/api/auth/customers` callers.
// ---------------------------------------------------------------------------

export interface GroupEligibleMember {
  id: string;
  name: string;
  externalKey: string;
  /** The customer's IANA timezone — drives the create-flow tz auto-fill. */
  timezone: string;
  /** Membership role name (e.g. "Manager"), null if analyst-only. */
  role: string | null;
  /** Whether the caller holds an eligible analyst assignment on this customer. */
  isAnalyst: boolean;
}

/**
 * List the customers `accountId` may pick as group members: accessible AND
 * manageable AND operational, with the timezone the create flow auto-fills
 * from. Ordered by name.
 */
export async function listGroupEligibleMembers(
  client: PoolClient,
  accountId: string,
): Promise<GroupEligibleMember[]> {
  const { rows } = await client.query<{
    id: string;
    name: string;
    external_key: string;
    timezone: string;
    role_name: string | null;
    is_analyst: boolean;
  }>(
    `SELECT c.id, c.name, c.external_key, c.timezone,
            r.name AS role_name,
            (aca.account_id IS NOT NULL AND a.analyst_eligible = true) AS is_analyst
     FROM customers c
     LEFT JOIN account_customer_memberships acm
       ON acm.customer_id = c.id AND acm.account_id = $1
     LEFT JOIN roles r ON r.id = acm.role_id
     LEFT JOIN analyst_customer_assignments aca
       ON aca.customer_id = c.id AND aca.account_id = $1
     CROSS JOIN accounts a
     WHERE a.id = $1
       AND c.status = 'active'
       AND c.database_status = 'active'
       AND (r.name = 'Manager'
            OR (aca.account_id IS NOT NULL AND a.analyst_eligible = true))
     ORDER BY c.name`,
    [accountId],
  );

  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    externalKey: r.external_key,
    timezone: r.timezone,
    role: r.role_name,
    isAnalyst: r.is_analyst,
  }));
}
