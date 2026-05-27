import type { Pool, PoolClient } from "pg";
import { withTransaction } from "@/lib/db/client";
import {
  ENGINE_VERSION,
  type RangeSet,
  RedactionInjectivityError,
  readMapWithLock,
  redact,
  writeMap,
} from "@/lib/redaction";
import type { BaselineBatch, PolicyRunPayload, StoryBatch } from "./schemas";

export interface IngestCounts {
  accepted: number;
  duplicatesSkipped: number;
}

/**
 * Data captured during a successful baseline batch so the route handler
 * can fire the RFC 0002 Phase 0 analysis state hook after the customer-
 * DB commit returns. See `src/lib/analysis/ingest-hooks.ts`.
 *
 * `acceptedEvents` lists every accepted event paired with the canonical
 * customer-DB `baseline_event.received_at` value RETURNING-ed at INSERT
 * time. The hook uses these `(eventTime, receivedAt)` tuples both to
 * dirty ALL affected DAILY/WEEKLY/MONTHLY buckets (RFC 0002 §"Dirty
 * transitions" rule 1, applied per affected bucket) and to forward-
 * patch `last_event_received_at` from the customer-DB source-of-truth
 * value (round-9 review item 2). Earlier revisions stored the batch's
 * max event_time only — which silently dropped dirty transitions on
 * every other done bucket the batch overran — and earlier still wrote
 * auth-DB `NOW()` for `last_event_received_at`, which under concurrent
 * commits could get ahead of a later commit's `received_at` and mask a
 * hook failure whose new event landed earlier than the bucket's max
 * `event_time`. Carrying the canonical `received_at` per event keeps
 * the hot path consistent with the reconcile forward-patch path, which
 * compares against `MAX(baseline_event.received_at)`.
 */
export interface BaselineIngestExtras {
  acceptedEvents: Array<{ eventTime: Date; receivedAt: Date }>;
}

/**
 * Data captured during a successful story batch so the route handler
 * can fire the RFC 0002 Phase 0 analysis state hook after the customer-
 * DB commit returns. One entry per `story_member` that was actually
 * inserted (duplicates are skipped). `arrivedAt` is the canonical
 * customer-DB `story.received_at` of the version the member belongs
 * to (round-7 review item 3) — not JS wall-clock time. Reconcile's
 * forward-only patch path can never roll `last_member_at` backwards,
 * so the hook MUST write the same source-of-truth value reconcile
 * derives.
 */
export interface StoryIngestExtras {
  storyArrivals: Array<{ storyId: string; arrivedAt: Date }>;
}

interface RedactionContext {
  customerId: string;
  aiceId: string;
  eventKey: string;
  ranges: RangeSet;
  client: PoolClient;
}

/**
 * Redact one Phase 2 event payload and UPSERT the matching
 * `event_redaction_map` row when needed (engine merged new entities
 * OR the row did not exist yet — second clause keeps the "every
 * ingested event has a map row" invariant from RFC 0001).
 *
 * Returns the redacted payload plus the
 * `engine:<semver>|ranges:<sha256-short>` policy version to stamp on
 * the referent row.
 */
async function redactAndMaybeUpsertMap(
  payload: unknown,
  ctx: RedactionContext,
): Promise<{ redacted: unknown; policyVersion: string }> {
  const existing = await readMapWithLock(
    ctx.client,
    ctx.customerId,
    ctx.aiceId,
    ctx.eventKey,
  );
  let out: ReturnType<typeof redact>;
  try {
    out = redact({
      payload,
      existingMap: existing ?? {},
      ranges: ctx.ranges,
      engineVersion: ENGINE_VERSION,
    });
  } catch (err) {
    // Engine has no per-event context — attach the failing
    // event_key so the route handler's
    // `redaction.injectivity_violation` audit can identify the
    // `(aice_id, event_key)` map row that needs investigation.
    if (err instanceof RedactionInjectivityError) {
      err.eventKey = ctx.eventKey;
    }
    throw err;
  }
  if (existing === null || out.mapChanged) {
    await writeMap(
      ctx.client,
      ctx.customerId,
      ctx.aiceId,
      ctx.eventKey,
      out.mergedMap,
    );
  }
  return { redacted: out.redacted, policyVersion: out.policyVersion };
}

// ---------------------------------------------------------------------------
// baseline_event
// ---------------------------------------------------------------------------

export async function ingestBaselineBatch(
  pool: Pool,
  payload: BaselineBatch,
  customerId: string,
  sourceAiceId: string,
  ranges: RangeSet,
): Promise<IngestCounts & BaselineIngestExtras> {
  if (payload.events.length === 0) {
    return {
      accepted: 0,
      duplicatesSkipped: 0,
      acceptedEvents: [],
    };
  }

  return withTransaction(pool, async (client) => {
    let accepted = 0;
    const acceptedEvents: Array<{ eventTime: Date; receivedAt: Date }> = [];
    for (const event of payload.events) {
      const { redacted, policyVersion } = await redactAndMaybeUpsertMap(
        event.raw_event,
        {
          customerId,
          aiceId: sourceAiceId,
          eventKey: event.event_key,
          ranges,
          client,
        },
      );
      // RETURNING received_at returns the customer-DB source-of-truth
      // received_at for newly-accepted events; rows skipped by
      // ON CONFLICT yield no RETURNING row (round-9 review item 2). The
      // hook downstream uses this value rather than auth-DB `NOW()` so a
      // bucket forward-patched after a hook failure compares like-for-
      // like against `MAX(baseline_event.received_at)` in reconcile.
      const result = await client.query<{ received_at: Date }>(
        `INSERT INTO baseline_event (
           baseline_version, event_key, event_time, kind, category,
           primary_asset, raw_score, selector_tags, raw_event,
           score_window_context, window_signals, asset_context,
           scoring_weights_snapshot, source_aice_id,
           redaction_policy_version
         ) VALUES (
           $1, $2::numeric, $3, $4, $5,
           $6, $7, $8, $9::jsonb,
           $10::jsonb, $11::jsonb, $12::jsonb,
           $13::jsonb, $14,
           $15
         )
         ON CONFLICT (baseline_version, event_key) DO NOTHING
         RETURNING received_at`,
        [
          payload.baseline_version,
          event.event_key,
          event.event_time,
          event.kind,
          event.category ?? null,
          event.primary_asset ?? null,
          event.raw_score,
          event.selector_tags,
          JSON.stringify(redacted),
          JSON.stringify(event.score_window_context),
          JSON.stringify(event.window_signals),
          event.asset_context == null
            ? null
            : JSON.stringify(event.asset_context),
          JSON.stringify(event.scoring_weights_snapshot),
          sourceAiceId,
          policyVersion,
        ],
      );
      if (result.rowCount === 1) {
        accepted += 1;
        acceptedEvents.push({
          eventTime: new Date(event.event_time),
          receivedAt: result.rows[0].received_at,
        });
      }
    }
    return {
      accepted,
      duplicatesSkipped: payload.events.length - accepted,
      acceptedEvents,
    };
  });
}

// ---------------------------------------------------------------------------
// story + story_member
// ---------------------------------------------------------------------------

export interface StoryIngestCounts extends IngestCounts, StoryIngestExtras {
  storiesAccepted: number;
  storiesDuplicates: number;
  membersAccepted: number;
  membersDuplicates: number;
}

export async function ingestStoryBatch(
  pool: Pool,
  payload: StoryBatch,
  customerId: string,
  sourceAiceId: string,
  ranges: RangeSet,
): Promise<StoryIngestCounts> {
  if (payload.stories.length === 0) {
    return {
      accepted: 0,
      duplicatesSkipped: 0,
      storiesAccepted: 0,
      storiesDuplicates: 0,
      membersAccepted: 0,
      membersDuplicates: 0,
      storyArrivals: [],
    };
  }

  return withTransaction(pool, async (client) => {
    let storiesAccepted = 0;
    let membersAccepted = 0;
    let totalMembers = 0;
    const storyArrivals: Array<{ storyId: string; arrivedAt: Date }> = [];

    for (const story of payload.stories) {
      // `story.summary_payload` is an aggregate (not redacted in v1 per
      // RFC 0001) — written through verbatim.
      const storyResult = await client.query<{ received_at: Date }>(
        `INSERT INTO story (
           story_id, story_version, kind, correlation_rule_id, primary_asset,
           time_window_start, time_window_end, score,
           summary_payload, source_aice_id
         ) VALUES (
           $1::bigint, $2, $3, $4, $5,
           $6, $7, $8,
           $9::jsonb, $10
         )
         ON CONFLICT (story_id, story_version) DO NOTHING
         RETURNING received_at`,
        [
          story.story_id,
          story.story_version,
          story.kind,
          story.correlation_rule_id ?? null,
          story.primary_asset ?? null,
          story.time_window.start,
          story.time_window.end,
          story.score ?? null,
          JSON.stringify(story.summary_payload),
          sourceAiceId,
        ],
      );
      let storyReceivedAt: Date;
      if (storyResult.rowCount === 1) {
        storiesAccepted += 1;
        storyReceivedAt = storyResult.rows[0].received_at;
      } else {
        // ON CONFLICT path: fetch the canonical `received_at` of the
        // existing row so member-arrival timestamps come from the
        // customer-DB source-of-truth value rather than JS wall-clock
        // time (round-7 review item 3). Reconcile's forward-only
        // patch path can only roll `last_member_at` forward; using
        // `new Date()` here would let a hook-time value get ahead of
        // the canonical `story.received_at`, and reconcile could
        // never roll it back.
        const { rows } = await client.query<{ received_at: Date }>(
          `SELECT received_at FROM story
            WHERE story_id = $1::bigint AND story_version = $2`,
          [story.story_id, story.story_version],
        );
        storyReceivedAt = rows[0].received_at;
      }

      for (const member of story.members) {
        totalMembers += 1;
        const { redacted, policyVersion } = await redactAndMaybeUpsertMap(
          member.event,
          {
            customerId,
            aiceId: sourceAiceId,
            eventKey: member.event_key,
            ranges,
            client,
          },
        );
        const memberResult = await client.query(
          `INSERT INTO story_member (
             story_id, story_version, member_event_key, role, event,
             redaction_policy_version
           ) VALUES ($1::bigint, $2, $3::numeric, $4, $5::jsonb, $6)
           ON CONFLICT (story_id, story_version, member_event_key) DO NOTHING`,
          [
            story.story_id,
            story.story_version,
            member.event_key,
            member.role,
            JSON.stringify(redacted),
            policyVersion,
          ],
        );
        if (memberResult.rowCount === 1) {
          membersAccepted += 1;
          // Use the canonical customer-DB `story.received_at` value as
          // the member-arrival timestamp (round-7 review item 3).
          // Decision 1 derives `story_analysis_state.last_member_at`
          // from `story.received_at`; reconcile's forward-only patch
          // path can only roll it forward. JS wall-clock `new Date()`
          // here would let a hook-time value get ahead of the
          // canonical source — reconcile could never roll it back.
          storyArrivals.push({
            storyId: story.story_id,
            arrivedAt: storyReceivedAt,
          });
        }
      }
    }

    return {
      // Response surfaces only story counts per RFC 0002 §6.
      accepted: storiesAccepted,
      duplicatesSkipped: payload.stories.length - storiesAccepted,
      storiesAccepted,
      storiesDuplicates: payload.stories.length - storiesAccepted,
      membersAccepted,
      membersDuplicates: totalMembers - membersAccepted,
      storyArrivals,
    };
  });
}

// ---------------------------------------------------------------------------
// policy_run + policy_event
// ---------------------------------------------------------------------------

export interface PolicyRunIngestCounts extends IngestCounts {
  runStatus: "new" | "duplicate";
}

export async function ingestPolicyRun(
  pool: Pool,
  payload: PolicyRunPayload,
  customerId: string,
  sourceAiceId: string,
  ranges: RangeSet,
): Promise<PolicyRunIngestCounts> {
  return withTransaction(pool, (client) =>
    insertPolicyRunInTx(client, payload, customerId, sourceAiceId, ranges),
  );
}

async function insertPolicyRunInTx(
  client: PoolClient,
  payload: PolicyRunPayload,
  customerId: string,
  sourceAiceId: string,
  ranges: RangeSet,
): Promise<PolicyRunIngestCounts> {
  const run = payload.run;
  // `run.summary_stats` is an aggregate (not redacted in v1 per RFC 0001)
  // — written through verbatim.
  const runResult = await client.query(
    `INSERT INTO policy_run (
       run_id, owner_account_id, period_start, period_end, created_at_source,
       finalized_at_source, baseline_version, policies_fingerprint,
       exclusions_fingerprint, status, replaces, summary_stats, source_aice_id
     ) VALUES (
       $1::bigint, $2, $3, $4, $5,
       $6, $7, $8,
       $9, $10, $11::bigint, $12::jsonb, $13
     )
     ON CONFLICT (run_id) DO NOTHING`,
    [
      run.run_id,
      run.owner_account_id ?? null,
      run.period_start,
      run.period_end,
      run.created_at,
      run.finalized_at ?? null,
      run.baseline_version,
      run.policies_fingerprint,
      run.exclusions_fingerprint,
      run.status,
      run.replaces ?? null,
      run.summary_stats == null ? null : JSON.stringify(run.summary_stats),
      sourceAiceId,
    ],
  );

  const runStatus: "new" | "duplicate" =
    runResult.rowCount === 1 ? "new" : "duplicate";

  let eventsAccepted = 0;
  for (const event of payload.events) {
    // Build the subset that needs redacting: the discrete fields the
    // engine walks, plus the snapshot. Run them through a single
    // redaction call so the map is updated once per event.
    const redactablePayload = {
      orig_addr: event.orig_addr ?? null,
      resp_addr: event.resp_addr ?? null,
      host: event.host ?? null,
      dns_query: event.dns_query ?? null,
      uri: event.uri ?? null,
      policy_triage_snapshot: event.policy_triage_snapshot,
    };
    const { redacted, policyVersion } = await redactAndMaybeUpsertMap(
      redactablePayload,
      {
        customerId,
        aiceId: sourceAiceId,
        eventKey: event.event_key,
        ranges,
        client,
      },
    );
    const redactedFields = redacted as {
      orig_addr: string | null;
      resp_addr: string | null;
      host: string | null;
      dns_query: string | null;
      uri: string | null;
      policy_triage_snapshot: unknown;
    };
    const eventResult = await client.query(
      `INSERT INTO policy_event (
         run_id, event_key, event_time, kind, sensor,
         orig_addr, orig_port, resp_addr, resp_port, proto,
         host, dns_query, uri, category, policy_triage_snapshot,
         redaction_policy_version
       ) VALUES (
         $1::bigint, $2::numeric, $3, $4, $5,
         $6, $7, $8, $9, $10,
         $11, $12, $13, $14, $15::jsonb,
         $16
       )
       ON CONFLICT (run_id, event_key) DO NOTHING`,
      [
        run.run_id,
        event.event_key,
        event.event_time,
        event.kind,
        event.sensor ?? null,
        redactedFields.orig_addr,
        event.orig_port ?? null,
        redactedFields.resp_addr,
        event.resp_port ?? null,
        event.proto ?? null,
        redactedFields.host,
        redactedFields.dns_query,
        redactedFields.uri,
        event.category ?? null,
        JSON.stringify(redactedFields.policy_triage_snapshot),
        policyVersion,
      ],
    );
    if (eventResult.rowCount === 1) eventsAccepted += 1;
  }

  return {
    accepted: eventsAccepted,
    duplicatesSkipped: payload.events.length - eventsAccepted,
    runStatus,
  };
}
