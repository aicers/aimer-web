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

async function rewrapCustomerEvents(
  client: { query: Pool["query"] },
  customerId: string,
  deps: Pick<RotationDeps, "transitConfig" | "rewrapDek">,
): Promise<number> {
  const keyName = customerTransitKeyName(customerId);
  let totalRewrapped = 0;
  let offset = 0;

  for (;;) {
    const batch = await client.query<{ id: string; wrapped_dek: string }>(
      "SELECT id, wrapped_dek FROM detection_events ORDER BY id LIMIT $1 OFFSET $2",
      [BATCH_SIZE, offset],
    );

    if (batch.rows.length === 0) break;

    for (const row of batch.rows) {
      const newWrapped = await deps.rewrapDek(
        deps.transitConfig,
        keyName,
        row.wrapped_dek,
      );
      await client.query(
        "UPDATE detection_events SET wrapped_dek = $1 WHERE id = $2",
        [newWrapped, row.id],
      );
      totalRewrapped++;
    }

    offset += batch.rows.length;
    if (batch.rows.length < BATCH_SIZE) break;
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
 *    wrapped_dek, rewrap all detection_events in customer DB.
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
