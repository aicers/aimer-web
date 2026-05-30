// Deterministic fixture seed for the RFC 0002 Phase 2 periodic report
// page captures (#297).
//
// Mirrors `story-analysis.seed.ts`: manual screenshots must be
// reproducible, so the capture is driven from a fixed synthetic seed
// rather than live review data. Every value below is a literal constant
// so re-running the capture spec produces byte-identical PNGs.
//
// The seed inserts the minimum the report page render consults:
//   - `periodic_report_state` (auth DB) — the loader returns `not_found`
//     without this row.
//   - `periodic_report_result` (customer DB) — supplies every rendered
//     field. `input_story_refs` / `input_event_refs` are empty so the
//     loader's token re-derivation is a no-op (no `event_redaction_map`
//     / OpenBao Transit dependency), and the section narratives are
//     clean plaintext with no `<<REDACTED_*_R{j}_*>>` tokens.
//
// The report page reads the customer's default `(tz, lang, model_name,
// model)` variant, with `tz` defaulting to `customers.timezone`. The
// seed reads that timezone (COALESCE to `UTC`) so the state/result rows
// match whatever the capture customer carries.

import type { Pool } from "pg";
import { customerOwnerUrl } from "./customer-db";

export const REPORT_LANG = "ENGLISH";
export const REPORT_MODEL_NAME = "openai";
export const REPORT_MODEL = "gpt-4o";
export const REPORT_PERIOD = "DAILY";
export const REPORT_BUCKET_DATE = "2026-05-26";

const REPORT_MODEL_ACTUAL = "gpt-4o-2024-08-06";
const REPORT_PROMPT_VERSION = "aimer-periodic-v1";
const REPORT_REQUESTED_AT = "2026-05-27T03:00:00Z";
const REPORT_REDACTION_POLICY = "engine:0.0.0|ranges:none";

// Keyed by aimer's real PERIODIC_SECURITY_REPORT output schema (#360):
// `executive_summary` / `period_outlook` are strings; `story_highlights` /
// `notable_events` / `baseline_observations` are arrays of Markdown strings.
const REPORT_SECTIONS = {
  executive_summary:
    "Activity this period was dominated by a credential-stuffing burst " +
    "against the SSO endpoint that reached an initial foothold, set " +
    "against a 31% rise in reconnaissance-category events versus the " +
    "prior day.",
  story_highlights: [
    "The highest-priority narrative was an account-takeover attempt: 412 " +
      "failed authentications in 60 seconds preceded a single success on a " +
      "privileged service account, after which the session pivoted toward " +
      "a domain controller (T1078, T1110.001).",
  ],
  notable_events: [
    "A single outbound C2 beacon to a newly-registered domain stood out " +
      "from the rest of the fleet (T1071.001); it was not part of any " +
      "correlated story this period.",
  ],
  baseline_observations: [
    "Reconnaissance events rose from 120 to 157 (+31%), clearing the " +
      "noise threshold; this was the dominant shift against the prior " +
      "window. Malware-category volume was flat.",
    "Top sensors by event count were unchanged from the prior day.",
  ],
  period_outlook:
    "Tomorrow's operator should re-check the SSO endpoint for renewed " +
    "credential-stuffing and confirm the flagged service account's " +
    "sessions stay revoked.",
};

/**
 * Seed the periodic report fixture for `customerId`. Inserts the auth-DB
 * `periodic_report_state` row and the customer-DB `periodic_report_result`
 * row for the default DAILY variant. Idempotent — re-running upserts the
 * same literal values so re-captures stay byte-identical.
 */
export async function seedReportAnalysisFixture(opts: {
  authPool: Pool;
  customerId: string;
}): Promise<void> {
  const tzRow = await opts.authPool.query<{ timezone: string | null }>(
    `SELECT timezone FROM customers WHERE id = $1`,
    [opts.customerId],
  );
  const tz = tzRow.rows[0]?.timezone ?? "UTC";

  await opts.authPool.query(
    `INSERT INTO periodic_report_state
       (customer_id, period, bucket_date, tz, status)
     VALUES ($1, $2, $3::date, $4, 'ready')
     ON CONFLICT (customer_id, period, bucket_date, tz)
     DO UPDATE SET status = 'ready'`,
    [opts.customerId, REPORT_PERIOD, REPORT_BUCKET_DATE, tz],
  );

  const { Pool } = await import("pg");
  const pool = new Pool({
    connectionString: customerOwnerUrl(opts.customerId),
  });
  try {
    await pool.query(
      `INSERT INTO periodic_report_result
         (customer_id, period, bucket_date, tz, lang, model_name, model,
          model_actual_version, prompt_version, generation,
          aggregate_severity_score, aggregate_likelihood_score,
          aggregate_ttp_tags, priority_tier, sections_jsonb,
          input_event_refs, input_story_refs, input_hash, input_watermark,
          redaction_policy_version, requested_by, requested_at)
       VALUES ($1, $2, $3::date, $4, $5, $6, $7,
               $8, $9, 1,
               0.72, 0.85,
               $10::jsonb, 'HIGH', $11::jsonb,
               '[]'::jsonb, '[]'::jsonb, $12, NULL,
               $13, NULL, $14::timestamptz)
       ON CONFLICT (customer_id, period, bucket_date, tz, lang, model_name, model, generation)
       DO UPDATE SET
         aggregate_severity_score   = EXCLUDED.aggregate_severity_score,
         aggregate_likelihood_score = EXCLUDED.aggregate_likelihood_score,
         aggregate_ttp_tags         = EXCLUDED.aggregate_ttp_tags,
         priority_tier              = EXCLUDED.priority_tier,
         sections_jsonb             = EXCLUDED.sections_jsonb,
         requested_at               = EXCLUDED.requested_at`,
      [
        opts.customerId,
        REPORT_PERIOD,
        REPORT_BUCKET_DATE,
        tz,
        REPORT_LANG,
        REPORT_MODEL_NAME,
        REPORT_MODEL,
        REPORT_MODEL_ACTUAL,
        REPORT_PROMPT_VERSION,
        JSON.stringify(["T1078", "T1110.001", "T1071.001"]),
        JSON.stringify(REPORT_SECTIONS),
        "sha256:fixture-report-daily",
        REPORT_REDACTION_POLICY,
        REPORT_REQUESTED_AT,
      ],
    );
  } finally {
    await pool.end();
  }
}
