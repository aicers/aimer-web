// ---------------------------------------------------------------------------
// Group creation-time cost guard constants (#511, RFC 0004 "Cost guard").
// ---------------------------------------------------------------------------

/**
 * Hard member-count cap for a customer group. A group bundles >= 2 customers
 * and the recurring generation cost scales with member count (each run
 * cross-reads every member DB into one LLM input — RFC 0004 Option B), so an
 * excessive member count is the v1 proxy for a clearly-excessive recurring
 * cost.
 *
 * Enforced authoritatively server-side in `POST /api/groups` (reject) and
 * surfaced informationally by `POST /api/groups/preview` (annotate). Lives in
 * one place so the threshold is tunable from a single spot.
 */
export const GROUP_MAX_MEMBERS = 10;
