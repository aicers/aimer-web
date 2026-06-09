import type { PoolClient } from "pg";
import { assertAllMemberManagement } from "@/lib/auth/group-authorization";
import { GROUP_MAX_MEMBERS } from "./constants";
import { fetchMemberStates, type MemberState } from "./groups";
import { isValidTimeZone, resolveGroupTimezone } from "./timezone";

// ---------------------------------------------------------------------------
// Shared group front-door validation (#511).
//
// The create (`POST /api/groups`) and cost-preview (`POST /api/groups/preview`)
// paths apply the SAME front-door checks — `memberIds` parsing, UUID /
// duplicate / min / max validation, IANA `tz` validation, the all-member
// Manager/Analyst gate, and the operational-member check — so they are
// factored here rather than duplicated. Create then layers on the write path;
// preview layers on the figure computation.
//
// The two paths diverge only at the cap and at tz divergence; both are
// parameterized by `capMode`:
//   - "reject"  (create):  an over-cap member count returns 400
//     `too_many_members`; members with divergent timezones and no chosen tz
//     return 400 `{ recommendedTz }`.
//   - "annotate" (preview): over-cap continues with `overMemberCap: true`;
//     tz divergence continues with `recommendedTz` set and `tz` left null.
// ---------------------------------------------------------------------------

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type GroupCapMode = "reject" | "annotate";

export interface ValidatedGroupMembers {
  memberIds: string[];
  memberCount: number;
  maxMembers: number;
  /** True only in "annotate" mode (in "reject" mode over-cap already 400'd). */
  overMemberCap: boolean;
  states: MemberState[];
  stateById: Map<string, MemberState>;
  /**
   * Resolved IANA bucket tz, or `null` when members' timezones diverge and no
   * `tz` was chosen (only possible in "annotate" mode — "reject" 400s first).
   */
  tz: string | null;
  /** Set when members' timezones diverge and no `tz` was chosen. */
  recommendedTz: string | null;
}

export type GroupMemberValidation =
  | { ok: true; value: ValidatedGroupMembers }
  | { ok: false; response: Response };

function fail(error: string, status: number): GroupMemberValidation {
  return { ok: false, response: Response.json({ error }, { status }) };
}

/**
 * Run the shared front-door validation against `body` ({ memberIds, tz? }).
 *
 * Returns `{ ok: false, response }` for any client error (the caller returns
 * the `response` verbatim) and `{ ok: true, value }` otherwise. The all-member
 * management gate throws `HttpError` (403) on failure, which the caller's
 * existing `HttpError` handler turns into a response — matching the create
 * path's prior behavior.
 */
export async function validateGroupMembers(
  client: PoolClient,
  accountId: string,
  body: Record<string, unknown>,
  capMode: GroupCapMode,
): Promise<GroupMemberValidation> {
  // memberIds: array of UUID strings, >= 2 DISTINCT, duplicates rejected.
  const memberIdsRaw = body.memberIds;
  if (
    !Array.isArray(memberIdsRaw) ||
    !memberIdsRaw.every((x) => typeof x === "string")
  ) {
    return fail("memberIds_required", 400);
  }
  const memberIds = memberIdsRaw as string[];
  if (!memberIds.every((id) => UUID_RE.test(id))) {
    return fail("invalid_member_id", 400);
  }
  if (new Set(memberIds).size !== memberIds.length) {
    // Duplicate ids must not satisfy the >= 2 check by repetition.
    return fail("duplicate_members", 400);
  }
  if (memberIds.length < 2) {
    return fail("too_few_members", 400);
  }

  // Member-count hard cap — the upper twin of the >= 2 lower bound. Create
  // rejects; preview annotates and continues.
  const overMemberCap = memberIds.length > GROUP_MAX_MEMBERS;
  if (overMemberCap && capMode === "reject") {
    return fail("too_many_members", 400);
  }

  // tz: validate IANA when supplied; otherwise resolved from members.
  const tzRaw = body.tz;
  let chosenTz: string | null = null;
  if (tzRaw !== undefined && tzRaw !== null) {
    if (typeof tzRaw !== "string" || !isValidTimeZone(tzRaw)) {
      return fail("invalid_timezone", 400);
    }
    chosenTz = tzRaw;
  }

  // Binding gate: Manager/Analyst on every member. A non-existent member
  // yields no grant and is rejected here as 403 (no existence leak), so
  // eligibility below only sees real customers. Throws HttpError(403).
  await assertAllMemberManagement(client, accountId, memberIds);

  // Every member must exist and be operational
  // (status='active' AND database_status='active').
  const states = await fetchMemberStates(client, memberIds);
  const stateById = new Map(states.map((s) => [s.id, s]));
  for (const id of memberIds) {
    const s = stateById.get(id);
    if (!s) {
      return fail("member_not_found", 400);
    }
    if (s.status !== "active" || s.databaseStatus !== "active") {
      return fail("member_not_operational", 422);
    }
  }

  // Resolve the bucket tz. The cost figures are tz-independent, so preview
  // ("annotate") never blocks on divergence — it annotates `recommendedTz`
  // and continues; create ("reject") returns 400 { recommendedTz }.
  const memberTzs = memberIds.map((id) => stateById.get(id)?.timezone ?? "UTC");
  const resolution = resolveGroupTimezone(memberTzs, chosenTz);
  let tz: string | null;
  let recommendedTz: string | null = null;
  if (resolution.ok) {
    tz = resolution.tz;
  } else if (capMode === "reject") {
    return {
      ok: false,
      response: Response.json(
        { recommendedTz: resolution.recommendedTz },
        { status: 400 },
      ),
    };
  } else {
    tz = null;
    recommendedTz = resolution.recommendedTz;
  }

  return {
    ok: true,
    value: {
      memberIds,
      memberCount: memberIds.length,
      maxMembers: GROUP_MAX_MEMBERS,
      overMemberCap,
      states,
      stateById,
      tz,
      recommendedTz,
    },
  };
}
