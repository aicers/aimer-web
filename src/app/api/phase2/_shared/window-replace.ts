import type { Pool } from "pg";
import { z } from "zod";
import { withTransaction } from "@/lib/db/client";
import { baselineEventSchema, storySchema } from "./schemas";

// ---------------------------------------------------------------------------
// Window-replace payload schema (refresh-window + backfill)
// ---------------------------------------------------------------------------

const windowTimestamp = z
  .string()
  .min(1)
  .refine((s) => !Number.isNaN(Date.parse(s)), "must be an ISO-8601 timestamp");

/**
 * Reject zero-width or reversed intervals (`from >= to`). The window
 * contract is a half-open `[from, to)` range — an empty interval would
 * pass the row-membership refines (every comparison fails, but those
 * only fire when the array is non-empty), consume the JTI, take the
 * advisory lock, delete nothing, and return 200 to the sender. That is
 * indistinguishable from a no-op success and almost certainly a sender
 * bug; fail fast at the schema layer instead.
 */
function refineFromLessThanTo<T extends { from: string; to: string }>(
  schema: z.ZodType<T>,
) {
  return schema.refine(
    (w) => {
      const f = Date.parse(w.from);
      const t = Date.parse(w.to);
      return !Number.isNaN(f) && !Number.isNaN(t) && f < t;
    },
    {
      message: "window.from must be strictly earlier than window.to",
      path: ["to"],
    },
  );
}

const baselineWindowSchema = refineFromLessThanTo(
  z.object({
    kind: z.literal("baseline_event"),
    from: windowTimestamp,
    to: windowTimestamp,
  }),
);

const storyWindowSchema = refineFromLessThanTo(
  z.object({
    kind: z.literal("story"),
    from: windowTimestamp,
    to: windowTimestamp,
  }),
);

/**
 * `stories[*].kind` MUST be `auto_correlated` (RFC 0002 §6
 * refresh-window: curated stories are NEVER affected). The DELETE
 * filter only removes `kind = 'auto_correlated'` rows; allowing
 * curated rows on the INSERT side would create an asymmetric mutation
 * surface where refresh/backfill can produce rows that the same
 * operation cannot subsequently delete.
 *
 * `storySchema` from #218 permits both kinds because it is the
 * ingest-side schema; here we narrow it with `.refine`.
 */
const autoCorrelatedStorySchema = storySchema.refine(
  (s) => s.kind === "auto_correlated",
  {
    message:
      "stories[*].kind must be 'auto_correlated' (refresh/backfill " +
      "do not affect curated stories)",
    path: ["kind"],
  },
);

const baselineRefreshBodySchema = z.object({
  external_key: z.string().min(1),
  source_aice_id: z.string().min(1).optional(),
  window: baselineWindowSchema,
  baseline_version: z.string().min(1),
  events: z.array(baselineEventSchema),
});

const storyRefreshBodySchema = z.object({
  external_key: z.string().min(1),
  source_aice_id: z.string().min(1).optional(),
  window: storyWindowSchema,
  stories: z.array(autoCorrelatedStorySchema),
});

function inWindow(ts: string, from: string, to: string): boolean {
  const t = Date.parse(ts);
  const f = Date.parse(from);
  const u = Date.parse(to);
  if (Number.isNaN(t) || Number.isNaN(f) || Number.isNaN(u)) return false;
  return t >= f && t < u;
}

/**
 * The window-replace payload schema is a union of the baseline and
 * story variants. We use `z.union` rather than `z.discriminatedUnion`
 * because the discriminator (`window.kind`) is nested; discriminated
 * unions require a top-level literal.
 *
 * `superRefine` enforces the cross-field invariants:
 *   - row-window membership (each event/story start inside `[from, to)`);
 *   - payload-internal uniqueness of natural keys (so `accepted ==
 *     events.length` / `stories.length` stays honest).
 *
 * The same schema feeds both `refresh-window` and `backfill` — the two
 * endpoints differ only in their `schema_version` claim and audit
 * action; the wire shape and semantics are identical.
 */
export const windowReplacePayloadSchema = z
  .union([baselineRefreshBodySchema, storyRefreshBodySchema])
  .superRefine((payload, ctx) => {
    if ("events" in payload) {
      const baselineVersion = payload.baseline_version;
      const seen = new Set<string>();
      payload.events.forEach((event, idx) => {
        if (
          !inWindow(event.event_time, payload.window.from, payload.window.to)
        ) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["events", idx, "event_time"],
            message:
              `event_time ${event.event_time} is outside the declared ` +
              `window [${payload.window.from}, ${payload.window.to})`,
          });
        }
        const key = `${baselineVersion}|${event.event_key}`;
        if (seen.has(key)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["events", idx, "event_key"],
            message:
              `duplicate (baseline_version, event_key) ` +
              `(${baselineVersion}, ${event.event_key}) in payload`,
          });
        }
        seen.add(key);
      });
    } else {
      const seenStories = new Set<string>();
      payload.stories.forEach((story, idx) => {
        if (
          !inWindow(
            story.time_window.start,
            payload.window.from,
            payload.window.to,
          )
        ) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["stories", idx, "time_window", "start"],
            message:
              `time_window.start ${story.time_window.start} is outside the ` +
              `declared window [${payload.window.from}, ${payload.window.to})`,
          });
        }
        const storyKey = `${story.story_id}|${story.story_version}`;
        if (seenStories.has(storyKey)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["stories", idx],
            message:
              `duplicate (story_id, story_version) ` +
              `(${story.story_id}, ${story.story_version}) in payload`,
          });
        }
        seenStories.add(storyKey);

        const seenMembers = new Set<string>();
        story.members.forEach((member, j) => {
          const memberKey = `${story.story_id}|${story.story_version}|${member.event_key}`;
          if (seenMembers.has(memberKey)) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ["stories", idx, "members", j, "event_key"],
              message:
                `duplicate (story_id, story_version, member_event_key) ` +
                `(${story.story_id}, ${story.story_version}, ${member.event_key}) ` +
                `in payload`,
            });
          }
          seenMembers.add(memberKey);
        });
      });
    }
  });
export type WindowReplacePayload = z.infer<typeof windowReplacePayloadSchema>;

// ---------------------------------------------------------------------------
// DB execution
// ---------------------------------------------------------------------------

export interface WindowReplaceCounts {
  accepted: number;
  deleted: number;
}

/**
 * Atomically replace the contents of a window in a single per-customer
 * transaction. The advisory lock is keyed on
 * `phase2_window|<window_kind>|<external_key>|<from>|<to>` via
 * `hashtextextended(..., 0)` in single-bigint form — refresh and
 * backfill of the same window thus serialize against each other.
 *
 * The single-bigint form (`pg_advisory_xact_lock(<bigint>)`) is used
 * because the two-int form `pg_advisory_xact_lock(<ns>, <bigint>::int4)`
 * silently raises `integer out of range` on roughly half of all
 * `hashtextextended` outputs.
 */
export async function executeWindowReplace(
  pool: Pool,
  payload: WindowReplacePayload,
  sourceAiceId: string,
): Promise<WindowReplaceCounts> {
  return withTransaction(pool, async (client) => {
    await client.query(
      `SELECT pg_advisory_xact_lock(
         hashtextextended(
           format('phase2_window|%s|%s|%s|%s',
             $1::text, $2::text, $3::text, $4::text),
           0
         )
       )`,
      [
        payload.window.kind,
        payload.external_key,
        payload.window.from,
        payload.window.to,
      ],
    );

    if ("events" in payload) {
      const deleteResult = await client.query(
        `DELETE FROM baseline_event
          WHERE baseline_version = $1
            AND event_time >= $2
            AND event_time <  $3`,
        [payload.baseline_version, payload.window.from, payload.window.to],
      );
      let accepted = 0;
      for (const event of payload.events) {
        const result = await client.query(
          `INSERT INTO baseline_event (
             baseline_version, event_key, event_time, kind, category,
             primary_asset, raw_score, selector_tags, raw_event,
             score_window_context, window_signals, asset_context,
             scoring_weights_snapshot, source_aice_id
           ) VALUES (
             $1, $2::numeric, $3, $4, $5,
             $6, $7, $8, $9::jsonb,
             $10::jsonb, $11::jsonb, $12::jsonb,
             $13::jsonb, $14
           )`,
          [
            payload.baseline_version,
            event.event_key,
            event.event_time,
            event.kind,
            event.category ?? null,
            event.primary_asset ?? null,
            event.raw_score,
            event.selector_tags,
            JSON.stringify(event.raw_event),
            JSON.stringify(event.score_window_context),
            JSON.stringify(event.window_signals),
            event.asset_context == null
              ? null
              : JSON.stringify(event.asset_context),
            JSON.stringify(event.scoring_weights_snapshot),
            sourceAiceId,
          ],
        );
        accepted += result.rowCount ?? 0;
      }
      return { accepted, deleted: deleteResult.rowCount ?? 0 };
    }

    // story window
    const deleteResult = await client.query(
      `DELETE FROM story
        WHERE kind = 'auto_correlated'
          AND time_window_start >= $1
          AND time_window_start <  $2`,
      [payload.window.from, payload.window.to],
    );
    let accepted = 0;
    for (const story of payload.stories) {
      const storyResult = await client.query(
        `INSERT INTO story (
           story_id, story_version, kind, correlation_rule_id, primary_asset,
           time_window_start, time_window_end, score,
           summary_payload, source_aice_id
         ) VALUES (
           $1::bigint, $2, $3, $4, $5,
           $6, $7, $8,
           $9::jsonb, $10
         )`,
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
      accepted += storyResult.rowCount ?? 0;

      for (const member of story.members) {
        await client.query(
          `INSERT INTO story_member (
             story_id, story_version, member_event_key, role, event
           ) VALUES ($1::bigint, $2, $3::numeric, $4, $5::jsonb)`,
          [
            story.story_id,
            story.story_version,
            member.event_key,
            member.role,
            JSON.stringify(member.event),
          ],
        );
      }
    }
    return { accepted, deleted: deleteResult.rowCount ?? 0 };
  });
}
