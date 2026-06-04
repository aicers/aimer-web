// Load a customer's `customer_redaction_ranges` rows from auth_db and
// turn them into the `RangeSet` the engine consumes.
//
// Empty result → empty RangeSet, which the engine treats as "redact
// no public IPs" — public IPs pass through (per RFC 0001 §"Redaction
// engine — v1 policy"); private/internal IPs are always redacted.
// The admin UI in #252 will eventually populate this table; until
// then every customer reaches the engine with an empty range set.

import "server-only";

import type { Pool } from "pg";
import { buildRangeSet } from "./ranges";
import type { RangeSet } from "./types";

export async function loadCustomerRanges(
  authPool: Pool,
  customerId: string,
): Promise<RangeSet> {
  const result = await authPool.query<{ cidr: string }>(
    `SELECT cidr::text AS cidr
     FROM customer_redaction_ranges
     WHERE customer_id = $1`,
    [customerId],
  );
  return buildRangeSet(result.rows.map((r) => r.cidr));
}
