import "server-only";

import { Client } from "pg";
import { encryptPayload } from "../crypto/envelope";
import {
  customerDbUrl,
  customerTransitKeyName,
  getCustomerRuntimeTemplateUrl,
} from "../db/customer-db";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface StoreApprovedEventsParams {
  customerId: string;
  aiceId: string;
  eventCount: number;
  schemaVersion: string;
  source: "bridge" | "manual";
  connectionId: string | null;
  ingestedBy: string;
  /** Pre-decrypted payload (must be decrypted before staged payload deletion). */
  plaintext: Buffer;
  payloadHash: string;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Store approved events in the customer database.
 *
 * Accepts an already-decrypted payload to avoid a race condition:
 * `updateCustomerStatus()` may delete the staged payload row when the
 * last customer is resolved, so the caller must decrypt **before**
 * updating the status.
 *
 * Must be called **before** `updateCustomerStatus()` so that a storage
 * failure keeps the staged status as "pending" (retryable). The auth_db
 * and customer_db are separate databases, so cross-database transactions
 * are not possible.
 *
 * 1. Re-encrypt with the customer's Transit key (customer-specific DEK)
 * 2. Insert into the customer's `detection_events` table
 */
export async function storeApprovedEvents(
  params: StoreApprovedEventsParams,
): Promise<string> {
  // 1. Re-encrypt with customer-specific Transit key
  const customerKeyName = customerTransitKeyName(params.customerId);
  const { ciphertext, wrappedDek } = await encryptPayload(
    params.plaintext,
    customerKeyName,
  );

  // 2. Store in customer_db (single connection, not a pool)
  const templateUrl = getCustomerRuntimeTemplateUrl();
  const dbUrl = customerDbUrl(templateUrl, params.customerId);
  const client = new Client({ connectionString: dbUrl });
  await client.connect();

  try {
    const result = await client.query<{ id: string }>(
      `INSERT INTO detection_events
         (aice_id, payload, wrapped_dek, event_count, schema_version,
          payload_hash, source, connection_id, ingested_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING id`,
      [
        params.aiceId,
        ciphertext,
        wrappedDek,
        params.eventCount,
        params.schemaVersion,
        params.payloadHash,
        params.source,
        params.connectionId,
        params.ingestedBy,
      ],
    );
    return result.rows[0].id;
  } finally {
    await client.end().catch(() => {});
  }
}
