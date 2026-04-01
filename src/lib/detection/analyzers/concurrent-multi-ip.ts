import type { Pool } from "pg";
import { insertAlert } from "..";
import { DEFAULT_COOLDOWN_MINUTES, isDuplicate } from "./deduplicate";

const WINDOW_MINUTES = 30;

/**
 * Detect accounts that signed in from multiple IPs within a window.
 * Uses recent sign_in_success events from audit_logs.
 */
export async function analyzeConcurrentMultiIp(pool: Pool): Promise<number> {
  let count = 0;

  const rows = await pool.query<{
    actor_id: string;
    ip_count: number;
    ips: string[];
    log_ids: string[];
  }>(
    `SELECT actor_id,
            COUNT(DISTINCT ip_address)::int AS ip_count,
            array_agg(DISTINCT ip_address) AS ips,
            array_agg(id ORDER BY id) AS log_ids
     FROM audit_logs
     WHERE action IN ('general.auth.sign_in_success', 'admin.auth.sign_in_success')
       AND ip_address IS NOT NULL
       AND timestamp > NOW() - INTERVAL '${WINDOW_MINUTES} minutes'
     GROUP BY actor_id
     HAVING COUNT(DISTINCT ip_address) >= 2`,
  );

  for (const row of rows.rows) {
    if (
      await isDuplicate(
        pool,
        "concurrent_multi_ip_sessions",
        DEFAULT_COOLDOWN_MINUTES,
        {
          actorId: row.actor_id,
        },
      )
    )
      continue;

    await insertAlert({
      indicator: "concurrent_multi_ip_sessions",
      actorId: row.actor_id,
      summary: {
        ipCount: row.ip_count,
        ips: row.ips,
        windowMinutes: WINDOW_MINUTES,
      },
      auditLogIds: row.log_ids.map(Number),
    });
    count++;
  }

  return count;
}
