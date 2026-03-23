import type { Pool, PoolClient } from "pg";
import { query } from "../db/client";
import type { IdTokenClaims } from "./oidc-validate";

export interface UpsertedAccount {
  id: string;
  status: string;
  token_version: number;
  locale: string | null;
}

/**
 * Insert or update an account based on OIDC issuer + subject.
 * Returns the account row regardless of whether it was created or updated.
 */
export async function upsertAccount(
  client: PoolClient,
  issuerUrl: string,
  claims: IdTokenClaims,
): Promise<UpsertedAccount> {
  const result = await client.query<UpsertedAccount>(
    `INSERT INTO accounts (oidc_issuer, oidc_subject, username, display_name, email, last_sign_in_at)
     VALUES ($1, $2, $3, $4, $5, NOW())
     ON CONFLICT (oidc_issuer, oidc_subject) DO UPDATE SET
       username = EXCLUDED.username,
       display_name = EXCLUDED.display_name,
       email = EXCLUDED.email,
       last_sign_in_at = NOW(),
       updated_at = NOW()
     RETURNING id, status, token_version, locale`,
    [
      issuerUrl,
      claims.sub,
      claims.preferred_username,
      claims.name ?? claims.preferred_username,
      claims.email ?? null,
    ],
  );
  return result.rows[0];
}

/**
 * Count the number of accessible customers for an account
 * (memberships + analyst assignments).
 */
export async function countAccessibleCustomers(
  pool: Pool,
  accountId: string,
): Promise<number> {
  const rows = await query<{ total: number }>(
    pool,
    `SELECT COUNT(*)::int AS total FROM (
       SELECT account_id FROM account_customer_memberships WHERE account_id = $1
       UNION ALL
       SELECT account_id FROM analyst_customer_assignments WHERE account_id = $1
     ) AS combined`,
    [accountId],
  );
  return rows[0].total;
}
