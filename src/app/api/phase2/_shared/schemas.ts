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
 * `run_id`, and `replaces`. We reject JSON numbers and out-of-range
 * values at the Zod layer so malformed payloads cannot reach the
 * `$::bigint` DB cast and burn the context-token `jti` on a 500.
 *
 * `story_id`, `run_id`, and `replaces` are all BIGSERIAL-derived
 * identifiers on the aice-web-next side, so we additionally require
 * them to be positive (>= 1).
 */
const BIGINT_MAX = BigInt("9223372036854775807");
const BIGINT_ONE = BigInt(1);

const stringifiedBigintPositive = z
  .string()
  .regex(/^[0-9]+$/, "must be a positive integer string (digits only)")
  .refine((s) => {
    try {
      const v = BigInt(s);
      return v >= BIGINT_ONE && v <= BIGINT_MAX;
    } catch {
      return false;
    }
  }, "must be a positive BIGINT in [1, 2^63 - 1]");

const isoTimestamp = z.string().min(1);

const jsonObject = z.record(z.string(), z.unknown());

/**
 * The cohort window the baseline snapshot was taken against. RFC 0002
 * §6 defines it as `{ from, to }` ISO timestamps; aimer-web stores it
 * as-is inside the `score_window_context` JSONB column. Extra keys are
 * accepted (passthrough) for forward-compatible additions.
 */
const kindCohortWindowSchema = z
  .object({
    from: isoTimestamp,
    to: isoTimestamp,
  })
  .passthrough();

/**
 * Schema for `baseline_event.score_window_context` (RFC 0002 §6 /
 * #218 AC). Requires the three baseline-context fields the read
 * helpers rely on; additional keys are accepted (passthrough) so
 * future minor extensions of `phase2.baseline.v1` do not require a
 * coordinated bump.
 */
const scoreWindowContextSchema = z
  .object({
    kind_cohort_window: kindCohortWindowSchema,
    kind_cohort_size: z.number().int().nonnegative(),
    baseline_rank_snapshot: z.number(),
  })
  .passthrough();

/**
 * One entry in `policy_event.policy_triage_snapshot`. RFC 0002 §6
 * requires each entry to identify the policy and carry its score;
 * additional keys are accepted (passthrough).
 */
const policyTriageItemSchema = z
  .object({
    policyId: z.string().min(1),
    score: z.number(),
  })
  .passthrough();

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
  score_window_context: scoreWindowContextSchema,
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
  story_id: stringifiedBigintPositive,
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
  policy_triage_snapshot: z.array(policyTriageItemSchema),
});
export type PolicyEvent = z.infer<typeof policyEventSchema>;

export const policyRunBodySchema = z.object({
  run_id: stringifiedBigintPositive,
  owner_account_id: z.string().uuid().nullable().optional(),
  period_start: isoTimestamp,
  period_end: isoTimestamp,
  created_at: isoTimestamp,
  finalized_at: isoTimestamp.nullable().optional(),
  baseline_version: z.string().min(1),
  policies_fingerprint: z.string().min(1),
  exclusions_fingerprint: z.string().min(1),
  status: z.enum(["ready", "superseded"]),
  replaces: stringifiedBigintPositive.nullable().optional(),
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
