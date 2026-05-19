import "server-only";

import { Client, type Pool } from "pg";
import { dekCache } from "../crypto/dek-cache";
import {
  getTransitConfig,
  rewrapDataKey,
  rotateTransitKey,
  type TransitConfig,
} from "../crypto/transit";
import {
  customerDbUrl,
  customerTransitKeyName,
  getCustomerOwnerTemplateUrl,
} from "../db/customer-db";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RotationResult {
  customersRotated: number;
  customersErrored: number;
  customerDeksRewrapped: number;
  eventDeksRewrapped: number;
  stagingDeksRewrapped: number;
  errors: Array<{ customerId: string; error: string }>;
}

/** Injectable dependencies for testing. */
export interface RotationDeps {
  transitConfig: TransitConfig;
  ownerTemplateUrl: string;
  rotateKey: (config: TransitConfig, keyName: string) => Promise<void>;
  rewrapDek: (
    config: TransitConfig,
    keyName: string,
    wrappedDek: string,
  ) => Promise<string>;
  connectCustomerDb: (
    url: string,
  ) => Promise<{ query: Pool["query"]; end: () => Promise<void> }>;
  clearCache: () => void;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

const BATCH_SIZE = 100;

/**
 * Rewrap the per-event DEKs in `event_redaction_map` under the
 * customer's freshly-rotated Transit key.
 *
 * Operating assumption: **no concurrent ingestion during rotation.**
 * Rotation is an operator-triggered maintenance event today. The
 * `FOR UPDATE` inside each batch is defence-in-depth so accidental
 * concurrent ingestion (an ingestion `INSERT ... ON CONFLICT DO
 * UPDATE` mutating a row the cursor has already returned) cannot
 * silently corrupt data — ingestion's UPSERT waits on the row-level
 * lock until the rotation's UPDATE commits.
 *
 * The lock does NOT cover: rows inserted by ingestion after the
 * cursor has already passed them, rows ingestion is in the middle of
 * inserting for the first time concurrently with the scan, or rows
 * whose DEK ingestion obtained (cached) under the old KEK and
 * INSERTs after rotation finishes. Closing those windows requires
 * the operational rule above; if it ever slips, a follow-up rotation
 * pass catches the missed rows.
 *
 * Pagination: keyset on the composite PK `(aice_id, event_key)`.
 * `event_redaction_map` has no surrogate `id` column, so the first
 * batch omits the cursor predicate (avoids inventing a sentinel
 * tuple that the schema does not forbid).
 *
 * Counter accumulation: bumped only after `COMMIT` returns so a
 * mid-batch rollback does not inflate `eventDeksRewrapped` with
 * rows that ended up not persisted.
 */
async function rewrapCustomerEvents(
  client: { query: Pool["query"] },
  customerId: string,
  deps: Pick<RotationDeps, "transitConfig" | "rewrapDek">,
): Promise<number> {
  const keyName = customerTransitKeyName(customerId);
  let totalRewrapped = 0;
  let cursor: { aiceId: string; eventKey: string } | null = null;

  interface MapRow {
    aice_id: string;
    event_key: string;
    wrapped_dek: string;
  }

  for (;;) {
    await client.query("BEGIN");
    let committedThisBatch = 0;
    try {
      const batchRows: MapRow[] = cursor
        ? (
            await client.query<MapRow>(
              `SELECT aice_id, event_key::text AS event_key, wrapped_dek
               FROM event_redaction_map
               WHERE (aice_id, event_key) > ($1, $2::numeric)
               ORDER BY aice_id, event_key
               LIMIT $3
               FOR UPDATE`,
              [cursor.aiceId, cursor.eventKey, BATCH_SIZE],
            )
          ).rows
        : (
            await client.query<MapRow>(
              `SELECT aice_id, event_key::text AS event_key, wrapped_dek
               FROM event_redaction_map
               ORDER BY aice_id, event_key
               LIMIT $1
               FOR UPDATE`,
              [BATCH_SIZE],
            )
          ).rows;

      if (batchRows.length === 0) {
        await client.query("COMMIT");
        break;
      }

      for (const row of batchRows) {
        const newWrapped = await deps.rewrapDek(
          deps.transitConfig,
          keyName,
          row.wrapped_dek,
        );
        await client.query(
          "UPDATE event_redaction_map SET wrapped_dek = $1 WHERE aice_id = $2 AND event_key = $3::numeric",
          [newWrapped, row.aice_id, row.event_key],
        );
        committedThisBatch++;
      }

      const last = batchRows[batchRows.length - 1];
      const lastBatchSize = batchRows.length;
      await client.query("COMMIT");

      totalRewrapped += committedThisBatch;
      cursor = { aiceId: last.aice_id, eventKey: last.event_key };
      if (lastBatchSize < BATCH_SIZE) break;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    }
  }

  return totalRewrapped;
}

function defaultDeps(): RotationDeps {
  return {
    transitConfig: getTransitConfig(),
    ownerTemplateUrl: getCustomerOwnerTemplateUrl(),
    rotateKey: rotateTransitKey,
    rewrapDek: rewrapDataKey,
    connectCustomerDb: async (url: string) => {
      const client = new Client({ connectionString: url });
      await client.connect();
      return {
        query: client.query.bind(client) as Pool["query"],
        end: () => client.end(),
      };
    },
    clearCache: () => dekCache.clear(),
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Rotate all Transit keys and rewrap all DEKs.
 *
 * 1. For each active customer: rotate Transit key, rewrap auth_db
 *    wrapped_dek, rewrap all event_redaction_map rows in customer DB.
 * 2. Rotate staging-events key, rewrap staged_event_payloads.
 * 3. Clear DEK cache.
 */
export async function rotateAllKeks(
  authPool: Pool,
  deps?: RotationDeps,
): Promise<RotationResult> {
  const d = deps ?? defaultDeps();

  const result: RotationResult = {
    customersRotated: 0,
    customersErrored: 0,
    customerDeksRewrapped: 0,
    eventDeksRewrapped: 0,
    stagingDeksRewrapped: 0,
    errors: [],
  };

  // 1. Customer keys
  const customers = await authPool.query<{
    id: string;
    wrapped_dek: string | null;
  }>("SELECT id, wrapped_dek FROM customers WHERE database_status = 'active'");

  for (const customer of customers.rows) {
    try {
      const keyName = customerTransitKeyName(customer.id);

      await d.rotateKey(d.transitConfig, keyName);

      if (customer.wrapped_dek) {
        const newWrapped = await d.rewrapDek(
          d.transitConfig,
          keyName,
          customer.wrapped_dek,
        );
        await authPool.query(
          "UPDATE customers SET wrapped_dek = $1 WHERE id = $2",
          [newWrapped, customer.id],
        );
        result.customerDeksRewrapped++;
      }

      const dbUrl = customerDbUrl(d.ownerTemplateUrl, customer.id);
      const conn = await d.connectCustomerDb(dbUrl);
      try {
        const eventCount = await rewrapCustomerEvents(conn, customer.id, d);
        result.eventDeksRewrapped += eventCount;
      } finally {
        await conn.end().catch(() => {});
      }

      result.customersRotated++;
    } catch (err) {
      result.customersErrored++;
      result.errors.push({
        customerId: customer.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // 2. Staging-events key
  const stagingKeyName = "staging-events";
  await d.rotateKey(d.transitConfig, stagingKeyName);

  const staged = await authPool.query<{ id: string; wrapped_dek: string }>(
    "SELECT id, wrapped_dek FROM staged_event_payloads",
  );

  for (const row of staged.rows) {
    const newWrapped = await d.rewrapDek(
      d.transitConfig,
      stagingKeyName,
      row.wrapped_dek,
    );
    await authPool.query(
      "UPDATE staged_event_payloads SET wrapped_dek = $1 WHERE id = $2",
      [newWrapped, row.id],
    );
    result.stagingDeksRewrapped++;
  }

  // 3. Clear DEK cache
  d.clearCache();

  return result;
}
