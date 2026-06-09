// Server-side loader for the GROUP analysis hub page
// (`/[locale]/subjects/{groupId}`) — RFC 0004 / #513 (C2).
//
// The customer hub (`customer-hub-page-loader.ts`) links a customer's reports,
// threat stories, and suspicious events. A group hub in v1 surfaces **reports
// only**: a group DB holds only `periodic_report_result` (B3 generated reports
// only), and no group-owned story/event artifacts exist — those surfaces are
// deferred to a follow-up (#513 scope note). So this loader resolves a single
// boolean: whether the viewer may read the group's reports.
//
// Permission policy: the reports section renders when the viewer holds
// `reports:read` on EVERY member (the all-member union `resolveGroupReadOutcome`
// enforces). The hub 404s when the viewer is not a member of every member
// customer (existence-hiding); an in-scope bridge session is a 403 (group reads
// are denied under a bridge, exactly like the customer report surfaces).

import "server-only";

import { getAuthCookie } from "@/lib/auth/cookies";
import { resolveGroupReadOutcome } from "@/lib/auth/group-authorization";
import { verifyJwtFull } from "@/lib/auth/jwt";
import { getSessionPolicy } from "@/lib/auth/session-policy";
import { validateSession } from "@/lib/auth/session-validator";
import { getAuthPool, withTransaction } from "@/lib/db/client";
import { getGroupWithMembers } from "@/lib/groups/groups";

export interface GroupHubSections {
  /** Reports entry card — the only section a group hub shows in v1. */
  reports: boolean;
}

export type GroupHubPageOutcome =
  | { kind: "unauthorized" }
  | { kind: "forbidden" }
  | { kind: "ok"; sections: GroupHubSections };

export interface GroupHubPageInput {
  groupId: string;
}

/**
 * Resolve the group hub's reports section. Returns:
 *   - `unauthorized` (→ 404) for a missing/invalid session, a non-existent
 *     group, or a viewer who is not a member of every member customer;
 *   - `forbidden` (→ 403) for an in-scope bridge session, or a member who lacks
 *     `reports:read` on at least one member;
 *   - `ok` with `sections.reports === true` otherwise.
 */
export async function loadGroupHubPage(
  input: GroupHubPageInput,
): Promise<GroupHubPageOutcome> {
  const token = await getAuthCookie("general");
  if (!token) return { kind: "unauthorized" };
  let claims: Awaited<ReturnType<typeof verifyJwtFull>>;
  try {
    claims = await verifyJwtFull(token, "general");
  } catch {
    return { kind: "unauthorized" };
  }

  const authPool = getAuthPool();

  let bridgeCustomerIds: string[] | null = null;
  try {
    const policy = await getSessionPolicy();
    const session = await validateSession(authPool, claims.sid, policy.general);
    bridgeCustomerIds = session.bridgeCustomerIds;
  } catch {
    return { kind: "unauthorized" };
  }

  // Bridge sessions cannot read group surfaces — denied outright (403),
  // `allowInBridge: false` is NOT loosened for groups (#513 inherits the
  // customer report-surface restriction).
  if (bridgeCustomerIds !== null) return { kind: "forbidden" };

  const outcome = await withTransaction(authPool, async (client) => {
    const group = await getGroupWithMembers(client, input.groupId);
    if (group === null) return "not_found" as const;
    return resolveGroupReadOutcome(
      client,
      claims.sub,
      group.memberIds,
      "reports:read",
    );
  });

  if (outcome === "not_found") return { kind: "unauthorized" };
  if (outcome === "forbidden") return { kind: "forbidden" };
  return { kind: "ok", sections: { reports: true } };
}
