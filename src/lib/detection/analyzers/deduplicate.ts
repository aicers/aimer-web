import type { Pool } from "pg";

/** Default cooldown window for alert deduplication. */
export const DEFAULT_COOLDOWN_MINUTES = 60;

/**
 * Check whether an alert with the given indicator already exists within
 * the cooldown window. Returns true if a duplicate exists.
 */
export async function isDuplicate(
  pool: Pool,
  indicator: string,
  cooldownMinutes: number,
  match: { actorId?: string; ipAddress?: string; jsonPath?: [string, string] },
): Promise<boolean> {
  const conditions = [
    "indicator = $1",
    "created_at > NOW() - $2::int * INTERVAL '1 minute'",
  ];
  const values: unknown[] = [indicator, cooldownMinutes];
  let idx = 3;

  if (match.actorId) {
    conditions.push(`actor_id = $${idx++}`);
    values.push(match.actorId);
  }
  if (match.ipAddress) {
    conditions.push(`ip_address = $${idx++}`);
    values.push(match.ipAddress);
  }
  if (match.jsonPath) {
    const keyIdx = idx++;
    const valIdx = idx++;
    conditions.push(`summary->>$${keyIdx} = $${valIdx}`);
    values.push(match.jsonPath[0], match.jsonPath[1]);
  }

  const result = await pool.query(
    `SELECT 1 FROM suspicious_activity_alerts
     WHERE ${conditions.join(" AND ")}
     LIMIT 1`,
    values,
  );
  return result.rows.length > 0;
}
