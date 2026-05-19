// Shared concurrency primitive for `event_redaction_map`.
//
// Every ingestion writer that produces a referent row (Phase 1
// `detection_events`, Phase 2 `baseline_event` / `story_member` /
// `policy_event`) UPSERTs the matching `(aice_id, event_key)` map row.
// Concurrent writers for the same logical event must serialise so the
// shared-map invariants (token reuse, append-only, value-token
// injectivity) hold across paths.
//
// Approach: per-(aice_id, event_key) Postgres advisory lock acquired
// inside the surrounding transaction. The lock auto-releases at
// COMMIT/ROLLBACK so callers cannot forget to release it. Compared to
// `INSERT ... ON CONFLICT ... FOR UPDATE`, the advisory lock works
// even when the row does not exist yet — and the schema's
// `(ciphertext, wrapped_dek)` columns can stay `NOT NULL` because we
// never need a placeholder row to lock.
//
// Caller MUST pass `eventKey` in canonical decimal form (no leading
// zeros). Validated upstream by `eventKeyString`; if two callers pass
// `"1"` and `"01"` they would hash to different lock keys and race
// past each other even though the DB collapses both to the same map
// row primary key. The canonical form makes the lock and PK agree.

import "server-only";

import type { PoolClient } from "pg";
import { decryptRedactionMap, encryptRedactionMap } from "./envelope-adapter";
import type { RedactionMap } from "./types";

/**
 * Acquire the per-event advisory lock and return the existing map for
 * `(aiceId, eventKey)`, or `null` if no row exists yet.
 *
 * The lock is held until the surrounding transaction commits or rolls
 * back — callers must therefore be inside a transaction.
 */
export async function readMapWithLock(
  client: PoolClient,
  customerId: string,
  aiceId: string,
  eventKey: string,
): Promise<RedactionMap | null> {
  await client.query(
    "SELECT pg_advisory_xact_lock(hashtextextended($1 || '|' || $2::text, 0))",
    [aiceId, eventKey],
  );
  const res = await client.query<{ ciphertext: Buffer; wrapped_dek: string }>(
    `SELECT ciphertext, wrapped_dek
     FROM event_redaction_map
     WHERE aice_id = $1 AND event_key = $2::numeric`,
    [aiceId, eventKey],
  );
  if (res.rows.length === 0) return null;
  return decryptRedactionMap(
    customerId,
    res.rows[0].ciphertext,
    res.rows[0].wrapped_dek,
  );
}

/**
 * Encrypt `map` under the customer's Transit key and UPSERT the
 * `event_redaction_map` row. Must be called inside the same
 * transaction that previously called {@link readMapWithLock} so the
 * advisory lock still holds.
 */
export async function writeMap(
  client: PoolClient,
  customerId: string,
  aiceId: string,
  eventKey: string,
  map: RedactionMap,
): Promise<void> {
  const { ciphertext, wrappedDek } = await encryptRedactionMap(customerId, map);
  await client.query(
    `INSERT INTO event_redaction_map
       (aice_id, event_key, ciphertext, wrapped_dek)
     VALUES ($1, $2::numeric, $3, $4)
     ON CONFLICT (aice_id, event_key)
     DO UPDATE SET
       ciphertext = EXCLUDED.ciphertext,
       wrapped_dek = EXCLUDED.wrapped_dek,
       updated_at = NOW()`,
    [aiceId, eventKey, ciphertext, wrappedDek],
  );
}
