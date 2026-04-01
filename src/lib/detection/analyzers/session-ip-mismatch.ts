import type { Pool } from "pg";
import { insertAlert } from "..";
import { DEFAULT_COOLDOWN_MINUTES, isDuplicate } from "./deduplicate";

const WINDOW_MINUTES = 30;
const THRESHOLD = 2;

/**
 * Detect sessions with IP or User-Agent changes mid-session.
 * Relies on session.ip_mismatch and session.ua_mismatch audit events.
 */
export async function analyzeSessionIpMismatch(pool: Pool): Promise<number> {
  let count = 0;

  const rows = await pool.query<{
    actor_id: string;
    sid: string;
    ip_address: string | null;
    mismatch_count: number;
    log_ids: string[];
  }>(
    `SELECT actor_id, sid, MIN(ip_address) AS ip_address,
            COUNT(*)::int AS mismatch_count,
            array_agg(id ORDER BY id) AS log_ids
     FROM audit_logs
     WHERE action IN ('session.ip_mismatch', 'session.ua_mismatch')
       AND timestamp > NOW() - INTERVAL '${WINDOW_MINUTES} minutes'
     GROUP BY actor_id, sid
     HAVING COUNT(*) >= $1`,
    [THRESHOLD],
  );

  for (const row of rows.rows) {
    if (
      await isDuplicate(pool, "session_ip_mismatch", DEFAULT_COOLDOWN_MINUTES, {
        actorId: row.actor_id,
      })
    )
      continue;

    await insertAlert({
      indicator: "session_ip_mismatch",
      actorId: row.actor_id,
      ipAddress: row.ip_address ?? undefined,
      summary: {
        sid: row.sid,
        mismatchCount: row.mismatch_count,
        windowMinutes: WINDOW_MINUTES,
      },
      auditLogIds: row.log_ids.map(Number),
    });
    count++;
  }

  return count;
}
