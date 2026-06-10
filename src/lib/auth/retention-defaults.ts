/**
 * Shared retention-policy defaults for runtime creation paths (#506).
 *
 * These govern the values written when a subject's retention-policy row
 * is first created: customer provisioning (`createCustomer`) and group
 * creation (`createGroup`). Extracting them into one constant means the
 * group analysis-retention default TRACKS the customer default rather
 * than being a second hardcoded literal that could silently drift.
 *
 * SCOPE: these are TS/runtime constants only. SQL migrations cannot
 * import them, so any migration column default keeps its own literal
 * with a comment cross-referencing the relevant constant here (see the
 * `customer_retention_policy` and `group_retention_policy` defaults in
 * `migrations/auth/0000_init.sql`). The constants are NOT a source for
 * migration DDL — only for the runtime inserts.
 */

/** Default ingestion-retention window (days) at customer provisioning. */
export const DEFAULT_INGESTION_RETENTION_DAYS = 365;

/**
 * Default analysis-retention window (days, ~36 months). Sourced by both
 * customer provisioning and group creation so the two stay in lockstep.
 */
export const DEFAULT_ANALYSIS_RETENTION_DAYS = 1095;
