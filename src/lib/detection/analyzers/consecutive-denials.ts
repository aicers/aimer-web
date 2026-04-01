import type { Pool } from "pg";
import { insertAlert } from "..";
import { DEFAULT_COOLDOWN_MINUTES, isDuplicate } from "./deduplicate";

const WINDOW_MINUTES = 15;
const THRESHOLD = 5;

const GROUPS = [
  {
    groupBy: "actor_id" as const,
    sql: `SELECT actor_id, MIN(ip_address) AS ip_address,
            COUNT(*)::int AS denial_count,
            array_agg(id ORDER BY id) AS log_ids
     FROM audit_logs
     WHERE action IN ('general.auth.sign_in_denied', 'admin.auth.sign_in_denied')
       AND timestamp > NOW() - INTERVAL '${WINDOW_MINUTES} minutes'
     GROUP BY actor_id
     HAVING COUNT(*) >= $1`,
    dedupKey: (row: { actor_id: string }) => ({ actorId: row.actor_id }),
    alertFields: (row: { actor_id: string; ip_address: string | null }) => ({
      actorId: row.actor_id,
      ipAddress: row.ip_address ?? undefined,
    }),
  },
  {
    groupBy: "ip_address" as const,
    sql: `SELECT ip_address,
            COUNT(*)::int AS denial_count,
            array_agg(id ORDER BY id) AS log_ids
     FROM audit_logs
     WHERE action IN ('general.auth.sign_in_denied', 'admin.auth.sign_in_denied')
       AND ip_address IS NOT NULL
       AND timestamp > NOW() - INTERVAL '${WINDOW_MINUTES} minutes'
     GROUP BY ip_address
     HAVING COUNT(*) >= $1`,
    dedupKey: (row: { ip_address: string }) => ({ ipAddress: row.ip_address }),
    alertFields: (row: { ip_address: string }) => ({
      ipAddress: row.ip_address,
    }),
  },
] as const;

/**
 * Detect accounts or IPs with repeated sign-in denials within a window.
 * Covers both general and admin auth contexts.
 */
export async function analyzeConsecutiveDenials(pool: Pool): Promise<number> {
  let count = 0;

  for (const group of GROUPS) {
    const result = await pool.query<{
      actor_id: string;
      ip_address: string | null;
      denial_count: number;
      log_ids: string[];
    }>(group.sql, [THRESHOLD]);

    for (const row of result.rows) {
      if (
        await isDuplicate(
          pool,
          "consecutive_sign_in_denials",
          DEFAULT_COOLDOWN_MINUTES,
          // biome-ignore lint/suspicious/noExplicitAny: row shape varies by group
          group.dedupKey(row as any),
        )
      )
        continue;

      await insertAlert({
        indicator: "consecutive_sign_in_denials",
        // biome-ignore lint/suspicious/noExplicitAny: row shape varies by group
        ...group.alertFields(row as any),
        summary: {
          denialCount: row.denial_count,
          windowMinutes: WINDOW_MINUTES,
          groupedBy: group.groupBy,
        },
        auditLogIds: row.log_ids.map(Number),
      });
      count++;
    }
  }

  return count;
}
