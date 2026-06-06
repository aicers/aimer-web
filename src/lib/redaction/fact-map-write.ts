// RFC 0003 C1 (#440) — `fact_id`-keyed redaction-map writer for
// `enrichment_redaction_map` (RFC 0001 Amendment A.1, fact side).
//
// Modeled on `map-write.ts` (`writeMap`) but keyed on `fact_id`, NOT on
// `(aice_id, event_key)`: an enrichment fact is its own redaction scope,
// self-contained and story-agnostic (the story linkage lives on
// `story_enrichment_fact`, never inside the encrypted map). `writeMap`
// cannot be reused directly because its UPSERT and advisory lock are
// `(aice_id, event_key)`-keyed.
//
// No advisory lock is needed here: each `fact_id` is freshly minted by
// the `story_enrichment_fact` INSERT (IDENTITY) and its map row is
// written exactly once, in the same transaction, immediately after.
// There is no concurrent writer for a given `fact_id`, unlike the shared
// `event_redaction_map` rows that many ingestion paths UPSERT.

import "server-only";

import type { PoolClient } from "pg";
import { decryptRedactionMap, encryptRedactionMap } from "./envelope-adapter";
import type { RedactionMap } from "./types";

/**
 * Encrypt `map` under the customer's Transit key and INSERT the
 * `enrichment_redaction_map` row for `factId`. Call inside the same
 * transaction that inserted the `story_enrichment_fact` row so the map
 * and its fact land atomically.
 */
export async function writeFactMap(
  client: PoolClient,
  customerId: string,
  factId: string,
  map: RedactionMap,
): Promise<void> {
  const { ciphertext, wrappedDek } = await encryptRedactionMap(customerId, map);
  await client.query(
    `INSERT INTO enrichment_redaction_map
       (fact_id, ciphertext, wrapped_dek)
     VALUES ($1::bigint, $2, $3)
     ON CONFLICT (fact_id)
     DO UPDATE SET
       ciphertext = EXCLUDED.ciphertext,
       wrapped_dek = EXCLUDED.wrapped_dek,
       updated_at = NOW()`,
    [factId, ciphertext, wrappedDek],
  );
}

/**
 * Read + decrypt the `enrichment_redaction_map` row for `factId`, or
 * `null` when no row exists (fact swept / never had a map). Read-only —
 * no advisory lock. Used by the story result page loader to demap
 * fact-scope `<<REDACTED_*_F{k}_*>>` tokens back to plaintext.
 */
export async function readFactMap(
  // biome-ignore lint/suspicious/noExplicitAny: pg Pool/PoolClient minimal surface
  queryable: any,
  customerId: string,
  factId: string,
): Promise<RedactionMap | null> {
  const { rows } = await queryable.query(
    `SELECT ciphertext, wrapped_dek
       FROM enrichment_redaction_map
      WHERE fact_id = $1::bigint`,
    [factId],
  );
  if (rows.length === 0) return null;
  return decryptRedactionMap(
    customerId,
    rows[0].ciphertext,
    rows[0].wrapped_dek,
  );
}
