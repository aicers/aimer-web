import type { Pool } from "pg";

/**
 * Result of attempting to consume a context-token jti.
 * `false` indicates the jti was already consumed (replay attempt).
 */
export type JtiConsumeResult = "consumed" | "replay";

/**
 * Attempt to consume a context-token jti against the Phase 2 replay
 * store (`phase2_consumed_jtis` in the auth DB).
 *
 * Returns `"consumed"` if the jti was newly inserted, `"replay"` if a
 * row with the same primary key already existed (translated to a
 * `409 Conflict` / `context_jti_replay` response by the caller).
 *
 * The check is intentionally an INSERT with `ON CONFLICT DO NOTHING`
 * rather than a SELECT-then-INSERT — the primary-key constraint is
 * what guarantees single-use semantics under concurrent calls.
 */
export async function consumePhase2Jti(
  pool: Pool,
  jti: string,
): Promise<JtiConsumeResult> {
  const result = await pool.query(
    `INSERT INTO phase2_consumed_jtis (jti)
     VALUES ($1)
     ON CONFLICT (jti) DO NOTHING`,
    [jti],
  );
  return result.rowCount === 1 ? "consumed" : "replay";
}
