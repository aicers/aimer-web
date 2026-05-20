import type { Pool, PoolClient } from "pg";
// Import directly from `engine` + `ranges` rather than the `./index`
// barrel — the barrel pulls in `envelope-adapter.ts` (a `server-only`
// module) which crashes Vitest unit tests running against mocked
// pools.
import { computePolicyVersion, ENGINE_VERSION } from "./engine";
import { buildRangeSet } from "./ranges";

/**
 * Load the customer's registered CIDRs from `auth_db` and return the
 * composite policy version string in the format
 * `engine:<semver>|ranges:<sha256-short>`. Used by:
 *
 *   - `/api/admin/customers/[id]/redaction-jobs/preview` to populate
 *     `target_policy_version` returned to the modal.
 *   - `/api/admin/customers/[id]/redaction-jobs` to stamp
 *     `redaction_jobs.target_policy_version` at trigger time.
 */
export async function computeCustomerPolicyVersion(
  authClient: Pool | PoolClient,
  customerId: string,
): Promise<string> {
  const { rows } = await authClient.query<{ cidr: string }>(
    `SELECT cidr::text AS cidr
     FROM customer_redaction_ranges
     WHERE customer_id = $1`,
    [customerId],
  );
  const ranges = buildRangeSet(rows.map((r) => r.cidr));
  return computePolicyVersion(ENGINE_VERSION, ranges);
}
