import type { Pool, PoolClient } from "pg";
import { withTransaction } from "@/lib/db/client";
import {
  ENGINE_VERSION,
  type RangeSet,
  readMapWithLock,
  redact,
  writeMap,
} from "@/lib/redaction";
import type { BaselineBatch, PolicyRunPayload, StoryBatch } from "./schemas";

export interface IngestCounts {
  accepted: number;
  duplicatesSkipped: number;
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
  const out = redact({
    payload,
    existingMap: existing ?? {},
    ranges: ctx.ranges,
    engineVersion: ENGINE_VERSION,
  });
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
): Promise<IngestCounts> {
  if (payload.events.length === 0) {
    return { accepted: 0, duplicatesSkipped: 0 };
  }

  return withTransaction(pool, async (client) => {
    let accepted = 0;
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
      const result = await client.query(
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
         ON CONFLICT (baseline_version, event_key) DO NOTHING`,
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
      if (result.rowCount === 1) accepted += 1;
    }
    return {
      accepted,
      duplicatesSkipped: payload.events.length - accepted,
    };
  });
}

// ---------------------------------------------------------------------------
// story + story_member
// ---------------------------------------------------------------------------

export interface StoryIngestCounts extends IngestCounts {
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
    };
  }

  return withTransaction(pool, async (client) => {
    let storiesAccepted = 0;
    let membersAccepted = 0;
    let totalMembers = 0;

    for (const story of payload.stories) {
      // `story.summary_payload` is an aggregate (not redacted in v1 per
      // RFC 0001) — written through verbatim.
      const storyResult = await client.query(
        `INSERT INTO story (
           story_id, story_version, kind, correlation_rule_id, primary_asset,
           time_window_start, time_window_end, score,
           summary_payload, source_aice_id
         ) VALUES (
           $1::bigint, $2, $3, $4, $5,
           $6, $7, $8,
           $9::jsonb, $10
         )
         ON CONFLICT (story_id, story_version) DO NOTHING`,
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
      if (storyResult.rowCount === 1) storiesAccepted += 1;

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
        if (memberResult.rowCount === 1) membersAccepted += 1;
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
