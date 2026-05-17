import { z } from "zod";

// ---------------------------------------------------------------------------
// Common building blocks
// ---------------------------------------------------------------------------

/**
 * `event_key` is a NUMERIC(39, 0) on the DB side. On the wire it travels
 * as a JSON string (RFC 0002 §6 — NUMERIC(39, 0) overflows JSON numbers).
 * Length is capped at 39 digits to match the DB precision; values with
 * more digits would fail the `$::numeric` cast after the route has
 * already consumed the context-token `jti`.
 */
const eventKeyString = z
  .string()
  .min(1)
  .max(39)
  .regex(/^[0-9]+$/, "event_key must be a non-negative integer string");

/**
 * Stringified BIGINT on the wire (RFC 0002 §6 — JSON numbers cannot
 * safely represent values that may exceed 2^53). Used for `story_id`,
 * `run_id`, and `replaces`. We reject JSON numbers at the Zod layer
 * so malformed payloads cannot reach the `$::bigint` DB cast.
 */
const stringifiedBigint = z
  .string()
  .regex(/^-?[0-9]+$/, "must be a stringified BIGINT (digits only)");

const isoTimestamp = z.string().min(1);

const jsonObject = z.record(z.string(), z.unknown());

// ---------------------------------------------------------------------------
// phase2.baseline.v1
// ---------------------------------------------------------------------------

export const baselineEventSchema = z.object({
  event_key: eventKeyString,
  event_time: isoTimestamp,
  kind: z.string().min(1),
  category: z.string().nullable().optional(),
  primary_asset: z.string().nullable().optional(),
  raw_score: z.number(),
  selector_tags: z.array(z.string()),
  raw_event: jsonObject,
  score_window_context: jsonObject,
  window_signals: jsonObject,
  asset_context: jsonObject.nullable().optional(),
  scoring_weights_snapshot: jsonObject,
});
export type BaselineEvent = z.infer<typeof baselineEventSchema>;

export const baselineBatchSchema = z.object({
  external_key: z.string().min(1),
  source_aice_id: z.string().min(1).optional(),
  baseline_version: z.string().min(1),
  events: z.array(baselineEventSchema),
});
export type BaselineBatch = z.infer<typeof baselineBatchSchema>;

// ---------------------------------------------------------------------------
// phase2.story.v1
// ---------------------------------------------------------------------------

export const storyMemberSchema = z.object({
  event_key: eventKeyString,
  role: z.enum(["primary", "context"]),
  event: jsonObject,
});
export type StoryMember = z.infer<typeof storyMemberSchema>;

export const storySchema = z.object({
  story_id: stringifiedBigint,
  story_version: z.string().min(1),
  kind: z.enum(["auto_correlated", "analyst_curated"]),
  correlation_rule_id: z.string().nullable().optional(),
  primary_asset: z.string().nullable().optional(),
  time_window: z.object({
    start: isoTimestamp,
    end: isoTimestamp,
  }),
  score: z.number().nullable().optional(),
  summary_payload: jsonObject,
  members: z.array(storyMemberSchema),
});
export type Story = z.infer<typeof storySchema>;

export const storyBatchSchema = z.object({
  external_key: z.string().min(1),
  source_aice_id: z.string().min(1).optional(),
  stories: z.array(storySchema),
});
export type StoryBatch = z.infer<typeof storyBatchSchema>;

// ---------------------------------------------------------------------------
// phase2.policy_run.v1
// ---------------------------------------------------------------------------

export const policyEventSchema = z.object({
  event_key: eventKeyString,
  event_time: isoTimestamp,
  kind: z.string().min(1),
  sensor: z.string().nullable().optional(),
  orig_addr: z.string().nullable().optional(),
  orig_port: z.number().int().nullable().optional(),
  resp_addr: z.string().nullable().optional(),
  resp_port: z.number().int().nullable().optional(),
  proto: z.number().int().nullable().optional(),
  host: z.string().nullable().optional(),
  dns_query: z.string().nullable().optional(),
  uri: z.string().nullable().optional(),
  category: z.string().nullable().optional(),
  policy_triage_snapshot: z.array(jsonObject),
});
export type PolicyEvent = z.infer<typeof policyEventSchema>;

export const policyRunBodySchema = z.object({
  run_id: stringifiedBigint,
  owner_account_id: z.string().uuid().nullable().optional(),
  period_start: isoTimestamp,
  period_end: isoTimestamp,
  created_at: isoTimestamp,
  finalized_at: isoTimestamp.nullable().optional(),
  baseline_version: z.string().min(1),
  policies_fingerprint: z.string().min(1),
  exclusions_fingerprint: z.string().min(1),
  status: z.enum(["ready", "superseded"]),
  replaces: stringifiedBigint.nullable().optional(),
  summary_stats: jsonObject.nullable().optional(),
});
export type PolicyRunBody = z.infer<typeof policyRunBodySchema>;

export const policyRunSchema = z.object({
  external_key: z.string().min(1),
  source_aice_id: z.string().min(1).optional(),
  run: policyRunBodySchema,
  events: z.array(policyEventSchema),
});
export type PolicyRunPayload = z.infer<typeof policyRunSchema>;
