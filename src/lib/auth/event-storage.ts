import "server-only";

import { createHash } from "node:crypto";
import type { Pool } from "pg";
import { z } from "zod";
import { withTransaction } from "../db/client";
import { getCustomerRuntimePool } from "../db/customer-runtime-pool";
import { eventKeyString } from "../event-key";
import type { RangeSet } from "../redaction";
import {
  ENGINE_VERSION,
  RedactionInjectivityError,
  readMapWithLock,
  redact,
  writeMap,
} from "../redaction";

// ---------------------------------------------------------------------------
// Phase 1 plaintext format
// ---------------------------------------------------------------------------

// One element of the `events` array in the decrypted plaintext. Only
// `event_key` is structurally validated here — the engine accepts any
// JSON object as the payload, so additional fields pass through.
const phase1EventSchema = z.object({ event_key: eventKeyString }).passthrough();

const phase1PayloadSchema = z.object({
  events: z.array(phase1EventSchema).min(1),
});

export type InvalidPhase1Reason = "invalid_plaintext" | "event_count_mismatch";

/**
 * Thrown when the decrypted Phase 1 plaintext does not match
 * {@link phase1PayloadSchema} or its `events.length` disagrees with
 * the `event_count` claim recorded at staging time. The outer route
 * maps the typed error to a `detection_events.transfer_failed` audit
 * row + 409 response; the staged row stays pending so an operator can
 * investigate (a retry will fail the same way — the data itself is
 * bad).
 */
export class InvalidPhase1PayloadError extends Error {
  readonly reason: InvalidPhase1Reason;
  constructor(reason: InvalidPhase1Reason, message: string) {
    super(message);
    this.name = "InvalidPhase1PayloadError";
    this.reason = reason;
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface StoreApprovedEventsParams {
  customerId: string;
  aiceId: string;
  /** `event_count` claimed at staging time — must match parsed `events.length`. */
  eventCount: number;
  schemaVersion: string;
  source: "bridge" | "manual";
  connectionId: string | null;
  ingestedBy: string;
  /** Pre-decrypted Phase 1 plaintext: `{ events: [{ event_key, ... }] }`. */
  plaintext: Buffer;
  /** Customer's registered public IP ranges (loaded by the route). */
  ranges: RangeSet;
}

/** Override hooks for tests. */
export interface StoreApprovedEventsDeps {
  getCustomerRuntimePool?: (customerId: string) => Pool;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Approve a Phase 1 batch into the customer database.
 *
 * 1. Parse the decrypted plaintext as `{ events: [...] }` (Zod;
 *    `event_key` validated as canonical decimal — see `eventKeyString`).
 * 2. Verify `events.length === eventCount` from the staged row.
 * 3. In a single customer_db transaction, for each event:
 *      - Lock `event_redaction_map` row by `(aice_id, event_key)`,
 *        read existing map (or `null` if first writer).
 *      - Run the redaction engine; merge new entities into the map.
 *      - `INSERT INTO detection_events ... ON CONFLICT DO NOTHING`.
 *      - If `existing === null || changed`, UPSERT the map row.
 *
 * Returns the per-event `detection_events.id` list (one entry per
 * input event; intra-batch duplicates collapse to the same row in DB
 * but appear twice in the returned list, matching the per-event input
 * shape so callers can correlate request order with DB ids).
 *
 * Cross-DB atomicity with auth_db is unchanged from before the
 * refactor (auth_db transaction holds the staged-row lock while this
 * function runs; the customer_db commit happens before auth_db status
 * flips, so a customer_db failure leaves the staged row pending).
 */
export async function storeApprovedEvents(
  params: StoreApprovedEventsParams,
  deps: StoreApprovedEventsDeps = {},
): Promise<string[]> {
  const resolvePool = deps.getCustomerRuntimePool ?? getCustomerRuntimePool;

  // 1. Parse plaintext.
  let parsed: {
    events: Array<{ event_key: string } & Record<string, unknown>>;
  };
  try {
    const raw: unknown = JSON.parse(params.plaintext.toString("utf8"));
    const result = phase1PayloadSchema.safeParse(raw);
    if (!result.success) {
      throw new InvalidPhase1PayloadError(
        "invalid_plaintext",
        `plaintext schema mismatch: ${result.error.message}`,
      );
    }
    parsed = result.data;
  } catch (err) {
    if (err instanceof InvalidPhase1PayloadError) throw err;
    throw new InvalidPhase1PayloadError(
      "invalid_plaintext",
      err instanceof Error ? err.message : String(err),
    );
  }

  // 2. Event count match.
  if (parsed.events.length !== params.eventCount) {
    throw new InvalidPhase1PayloadError(
      "event_count_mismatch",
      `events.length=${parsed.events.length} does not match staged event_count=${params.eventCount}`,
    );
  }

  // 3. Fan-out write inside a single customer_db transaction.
  const customerPool = resolvePool(params.customerId);
  return withTransaction(customerPool, async (client) => {
    const eventIds: string[] = [];
    for (const event of parsed.events) {
      const eventKey = event.event_key;

      const existing = await readMapWithLock(
        client,
        params.customerId,
        params.aiceId,
        eventKey,
      );
      let out: ReturnType<typeof redact>;
      try {
        out = redact({
          payload: event,
          existingMap: existing ?? {},
          ranges: params.ranges,
          engineVersion: ENGINE_VERSION,
        });
      } catch (err) {
        // Engine has no per-event context — attach the failing
        // event_key so the outer route's
        // `redaction.injectivity_violation` audit can identify the
        // `(aice_id, event_key)` map row that needs investigation.
        if (err instanceof RedactionInjectivityError) {
          err.eventKey = eventKey;
        }
        throw err;
      }

      const redactedJson = JSON.stringify(out.redacted);
      // Per-event payload_hash (RFC 0001): SHA-256 of the redacted
      // canonical form. Used by retroactive jobs to detect drift.
      const perEventHash = createHash("sha256")
        .update(redactedJson)
        .digest("hex");

      const inserted = await client.query<{ id: string }>(
        `INSERT INTO detection_events
           (aice_id, event_key, redacted_event, redaction_policy_version,
            schema_version, payload_hash, source, connection_id, ingested_by)
         VALUES ($1, $2::numeric, $3::jsonb, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (aice_id, event_key) DO NOTHING
         RETURNING id`,
        [
          params.aiceId,
          eventKey,
          redactedJson,
          out.policyVersion,
          params.schemaVersion,
          perEventHash,
          params.source,
          params.connectionId,
          params.ingestedBy,
        ],
      );

      let id: string;
      if (inserted.rows.length > 0) {
        id = inserted.rows[0].id;
      } else {
        // Idempotent retry or intra-batch duplicate event_key. Read the
        // existing row's id so the caller can still correlate input
        // events with DB rows.
        const dup = await client.query<{ id: string }>(
          `SELECT id FROM detection_events
           WHERE aice_id = $1 AND event_key = $2::numeric`,
          [params.aiceId, eventKey],
        );
        id = dup.rows[0].id;
      }
      eventIds.push(id);

      if (existing === null || out.mapChanged) {
        await writeMap(
          client,
          params.customerId,
          params.aiceId,
          eventKey,
          out.mergedMap,
        );
      }
    }
    return eventIds;
  });
}
