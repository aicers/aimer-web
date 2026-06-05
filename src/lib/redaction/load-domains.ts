// Load a customer's `customer_owned_domains` rows from auth_db and turn
// them into the `OwnedDomainSet` the engine consumes (RFC 0001
// Amendment A.2).
//
// Empty result → empty OwnedDomainSet, which the engine treats as
// "redact no domains" — every domain passes through (parallel to an
// empty RangeSet passing public IPs through). The owned-domains admin
// UI lands with the broader customer-settings work; until then every
// customer reaches the engine with an empty owned-domain set.

import "server-only";

import type { Pool } from "pg";
import { buildOwnedDomainSet } from "./domains";
import type { OwnedDomainSet } from "./types";

export async function loadCustomerOwnedDomains(
  authPool: Pool,
  customerId: string,
): Promise<OwnedDomainSet> {
  const result = await authPool.query<{ owned_domain_suffix: string }>(
    `SELECT owned_domain_suffix
     FROM customer_owned_domains
     WHERE customer_id = $1`,
    [customerId],
  );
  return buildOwnedDomainSet(result.rows.map((r) => r.owned_domain_suffix));
}
