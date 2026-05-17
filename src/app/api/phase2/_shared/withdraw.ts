import type { Pool } from "pg";
import { z } from "zod";
import { withTransaction } from "@/lib/db/client";
import { eventKeyString, stringifiedBigintPositive } from "./schemas";

// ---------------------------------------------------------------------------
// Withdrawal payload schema (RFC 0002 §6 withdraw)
// ---------------------------------------------------------------------------

const withdrawalBaselineEventSchema = z.object({
  kind: z.literal("baseline_event"),
  baseline_version: z.string().min(1),
  event_keys: z.array(eventKeyString).min(1),
});

const withdrawalStorySchema = z.object({
  kind: z.literal("story"),
  story_id: stringifiedBigintPositive,
  story_version: z.string().min(1),
});

const withdrawalPolicyEventSchema = z.object({
  kind: z.literal("policy_event"),
  run_id: stringifiedBigintPositive,
  event_keys: z.array(eventKeyString).min(1),
});

const withdrawalPolicyRunSchema = z.object({
  kind: z.literal("policy_run"),
  run_id: stringifiedBigintPositive,
});

export const withdrawalItemSchema = z.discriminatedUnion("kind", [
  withdrawalBaselineEventSchema,
  withdrawalStorySchema,
  withdrawalPolicyEventSchema,
  withdrawalPolicyRunSchema,
]);
export type WithdrawalItem = z.infer<typeof withdrawalItemSchema>;

/**
 * The payload-internal duplicate guard rejects natural-key collisions
 * across all four withdrawal kinds. Without it, the second DELETE of
 * the same row would be counted as `not_found` (instead of failing
 * fast as the sender-bug it really is) and the response counts would
 * silently misrepresent the input.
 *
 * The natural-key tuples are:
 *   baseline_event → (baseline_version, event_key)
 *   story          → (story_id, story_version)
 *   policy_event   → (run_id, event_key)
 *   policy_run     → (run_id)
 *
 * The guard covers both within-array duplicates (two event_keys in one
 * item) and across-item duplicates (two items referencing the same
 * natural key).
 *
 * Additionally, a `policy_run` withdrawal cascades to its child
 * `policy_event` rows (FK in migrations/customer/0002). If a payload
 * combines `{ kind: "policy_run", run_id: R }` with any
 * `{ kind: "policy_event", run_id: R, ... }` for the same run, the
 * count attributed to the explicit policy_event withdrawal depends on
 * the order items are processed — `withdrawn` when the event item is
 * processed first, `not_found` after the run's cascade has already
 * removed the rows. We reject this overlap at the schema layer so the
 * response counts cannot misrepresent a sender bug.
 */
export const withdrawPayloadSchema = z
  .object({
    external_key: z.string().min(1),
    source_aice_id: z.string().min(1).optional(),
    withdrawals: z.array(withdrawalItemSchema).min(1),
  })
  .superRefine((payload, ctx) => {
    const seen = new Set<string>();
    const policyRunIds = new Set<string>();
    payload.withdrawals.forEach((item) => {
      if (item.kind === "policy_run") {
        policyRunIds.add(item.run_id);
      }
    });
    payload.withdrawals.forEach((item, idx) => {
      if (item.kind === "baseline_event") {
        item.event_keys.forEach((ek, j) => {
          const key = `baseline_event|${item.baseline_version}|${ek}`;
          if (seen.has(key)) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ["withdrawals", idx, "event_keys", j],
              message: `duplicate withdrawal natural key (${item.baseline_version}, ${ek})`,
            });
          }
          seen.add(key);
        });
      } else if (item.kind === "story") {
        const key = `story|${item.story_id}|${item.story_version}`;
        if (seen.has(key)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["withdrawals", idx],
            message: `duplicate withdrawal natural key (${item.story_id}, ${item.story_version})`,
          });
        }
        seen.add(key);
      } else if (item.kind === "policy_event") {
        if (policyRunIds.has(item.run_id)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["withdrawals", idx],
            message: `policy_event withdrawal for run_id ${item.run_id} overlaps with a policy_run withdrawal in the same payload; the run's FK cascade already removes its policy_event rows`,
          });
        }
        item.event_keys.forEach((ek, j) => {
          const key = `policy_event|${item.run_id}|${ek}`;
          if (seen.has(key)) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ["withdrawals", idx, "event_keys", j],
              message: `duplicate withdrawal natural key (${item.run_id}, ${ek})`,
            });
          }
          seen.add(key);
        });
      } else {
        const key = `policy_run|${item.run_id}`;
        if (seen.has(key)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["withdrawals", idx],
            message: `duplicate withdrawal natural key (${item.run_id})`,
          });
        }
        seen.add(key);
      }
    });
  });
export type WithdrawPayload = z.infer<typeof withdrawPayloadSchema>;

// ---------------------------------------------------------------------------
// DB execution
// ---------------------------------------------------------------------------

export interface WithdrawCounts {
  withdrawn: number;
  notFound: number;
  kindsTouched: WithdrawalItem["kind"][];
}

/**
 * Execute all DELETEs in a single per-customer transaction.
 *
 * For `policy_run`, child `policy_event` rows cascade via the FK in
 * `migrations/customer/0002_phase2_tables.sql`. For `story`,
 * `story_member` rows cascade likewise. Withdraw does NOT issue
 * explicit DELETEs against the child tables — the cascade is the
 * source of truth and an explicit DELETE would invite drift if the
 * cascade is ever modified.
 */
export async function executeWithdraw(
  pool: Pool,
  payload: WithdrawPayload,
): Promise<WithdrawCounts> {
  return withTransaction(pool, async (client) => {
    let withdrawn = 0;
    let requested = 0;
    const kindsSet = new Set<WithdrawalItem["kind"]>();

    for (const item of payload.withdrawals) {
      kindsSet.add(item.kind);
      switch (item.kind) {
        case "baseline_event": {
          for (const ek of item.event_keys) {
            requested += 1;
            const result = await client.query(
              `DELETE FROM baseline_event
                WHERE baseline_version = $1
                  AND event_key = $2::numeric`,
              [item.baseline_version, ek],
            );
            withdrawn += result.rowCount ?? 0;
          }
          break;
        }
        case "story": {
          requested += 1;
          const result = await client.query(
            `DELETE FROM story
              WHERE story_id = $1::bigint
                AND story_version = $2`,
            [item.story_id, item.story_version],
          );
          withdrawn += result.rowCount ?? 0;
          break;
        }
        case "policy_event": {
          for (const ek of item.event_keys) {
            requested += 1;
            const result = await client.query(
              `DELETE FROM policy_event
                WHERE run_id = $1::bigint
                  AND event_key = $2::numeric`,
              [item.run_id, ek],
            );
            withdrawn += result.rowCount ?? 0;
          }
          break;
        }
        case "policy_run": {
          requested += 1;
          const result = await client.query(
            `DELETE FROM policy_run WHERE run_id = $1::bigint`,
            [item.run_id],
          );
          withdrawn += result.rowCount ?? 0;
          break;
        }
      }
    }

    return {
      withdrawn,
      notFound: requested - withdrawn,
      kindsTouched: [...kindsSet],
    };
  });
}
