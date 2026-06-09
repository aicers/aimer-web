import "server-only";

// ---------------------------------------------------------------------------
// Group data-DB naming + connection helpers (#507).
//
// Peer of customer-db.ts. A customer group gets its own dedicated data DB
// (a peer of the per-customer DBs) holding generated results only. These
// helpers mirror the customer ones 1:1; generalizing both into a single
// subject-keyed helper is deliberately out of scope (parallel helpers keep
// the blast radius small — the issue's stated preference).
//
// ROLE / ENV STRATEGY (pinned): group provisioning REUSES the existing
// shared subject-DB roles and URL templates — `aimer_customer_owner` /
// `aimer_customer` and `CUSTOMER_DATABASE_OWNER_URL` /
// `CUSTOMER_DATABASE_URL`. The DB name in those template URLs is a
// placeholder that is swapped per database, so the same templates address
// `group_<uuid>` DBs by swapping in the group DB name. Reuse is the
// lowest-blast-radius choice: it needs no new roles in the infra
// bootstrap (infra/postgres/init-databases.sql) and no new env vars
// across `.env.example`, CI, and the e2e/test fixtures. The roles are
// generic per-subject owner/runtime roles, not customer-semantic.
// ---------------------------------------------------------------------------

// Group advisory-lock base, well clear of the customer range
// (2000 – 1_002_000) and the auth (1000) / audit (1001) lock ids, while
// staying within the int4 range pg advisory locks accept.
const LOCK_ID_GROUP_BASE = 1_500_000_000;

/**
 * Derive the PostgreSQL database name for a group.
 * Convention: `group_<uuid_without_hyphens>` (peer of `customerDbName`).
 */
export function groupDbName(groupId: string): string {
  return `group_${groupId.replace(/-/g, "")}`;
}

/**
 * Derive the Transit key name for a group's DEK (peer of
 * `customerTransitKeyName`).
 */
export function groupTransitKeyName(groupId: string): string {
  return `group-${groupId}`;
}

/**
 * Compute an advisory lock ID for a group's migration runner. Uses a
 * simple hash of the UUID to produce a stable integer in the group range,
 * avoiding collisions with the customer / auth / audit lock ids.
 */
export function groupLockId(groupId: string): number {
  let hash = 0;
  for (const ch of groupId) {
    hash = (hash * 31 + ch.charCodeAt(0)) | 0;
  }
  return LOCK_ID_GROUP_BASE + Math.abs(hash % 1_000_000);
}

/**
 * Build a connection string for a group database by replacing the
 * database name component in a template URL (peer of `customerDbUrl`).
 *
 * @param templateUrl - A PostgreSQL connection URL with a placeholder DB name
 * @param groupId     - The group's UUID
 */
export function groupDbUrl(templateUrl: string, groupId: string): string {
  const dbName = groupDbName(groupId);
  return templateUrl.replace(/\/[^/?]+(\?|$)/, `/${dbName}$1`);
}

/**
 * Return the template URL for group DB owner connections (migrations).
 * Reuses the shared subject-DB owner template; the database name is
 * replaced per group.
 */
export function getGroupOwnerTemplateUrl(): string {
  const url = process.env.CUSTOMER_DATABASE_OWNER_URL;
  if (!url) {
    throw new Error(
      "CUSTOMER_DATABASE_OWNER_URL environment variable is required",
    );
  }
  return url;
}

/**
 * Return the template URL for group DB runtime connections. Uses the
 * restricted `aimer_customer` role (`CUSTOMER_DATABASE_URL`) — never the
 * owner role.
 */
export function getGroupRuntimeTemplateUrl(): string {
  const url = process.env.CUSTOMER_DATABASE_URL;
  if (!url) {
    throw new Error("CUSTOMER_DATABASE_URL environment variable is required");
  }
  return url;
}
