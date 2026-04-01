import type { Pool } from "pg";
import { insertAlert } from "..";
import { DEFAULT_COOLDOWN_MINUTES, isDuplicate } from "./deduplicate";

const WINDOW_MINUTES = 15;
const THRESHOLD = 10;

/**
 * Detect AICE environments with abnormally frequent bridge connection
 * requests within a window.
 */
export async function analyzeBridgeAbuse(pool: Pool): Promise<number> {
  let count = 0;

  const rows = await pool.query<{
    aice_id: string;
    request_count: number;
    log_ids: string[];
  }>(
    `SELECT aice_id,
            COUNT(*)::int AS request_count,
            array_agg(id ORDER BY id) AS log_ids
     FROM audit_logs
     WHERE action = 'bridge.connection_request'
       AND aice_id IS NOT NULL
       AND timestamp > NOW() - INTERVAL '${WINDOW_MINUTES} minutes'
     GROUP BY aice_id
     HAVING COUNT(*) >= $1`,
    [THRESHOLD],
  );

  for (const row of rows.rows) {
    if (
      await isDuplicate(pool, "bridge_abuse", DEFAULT_COOLDOWN_MINUTES, {
        jsonPath: ["aiceId", row.aice_id],
      })
    )
      continue;

    await insertAlert({
      indicator: "bridge_abuse",
      summary: {
        aiceId: row.aice_id,
        requestCount: row.request_count,
        windowMinutes: WINDOW_MINUTES,
      },
      auditLogIds: row.log_ids.map(Number),
    });
    count++;
  }

  return count;
}
