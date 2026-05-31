// Deterministic fixture seed for the RFC 0002 periodic report page
// captures (#297 DAILY, #298 WEEKLY/MONTHLY).
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
// Three periods are seeded so the manual can show the DAILY, WEEKLY, and
// MONTHLY report views and the period tab bar. WEEKLY / MONTHLY framing
// is "within-window" — escalating / easing / steady read from the single
// window's evidence, never a fabricated prior-period numeric delta — to
// match the merged aimer#434 prompt behaviour the Phase 3 gate verified.
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

// DAILY (existing #297 capture).
export const REPORT_PERIOD = "DAILY";
export const REPORT_BUCKET_DATE = "2026-05-26";

// WEEKLY — bucket date is the ISO Monday of the week (#298). 2026-05-18
// is a Monday; the window is 2026-05-18 … 2026-05-25.
export const REPORT_PERIOD_WEEKLY = "WEEKLY";
export const REPORT_BUCKET_DATE_WEEKLY = "2026-05-18";

// MONTHLY — bucket date is the first of the month (#298). The window is
// the calendar month 2026-05-01 … 2026-06-01.
export const REPORT_PERIOD_MONTHLY = "MONTHLY";
export const REPORT_BUCKET_DATE_MONTHLY = "2026-05-01";

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

// WEEKLY sections — a week-in-review that abstracts a recurring
// business-email-compromise campaign rather than re-listing each day. The
// trajectory (escalating across the week, culminating in payment fraud)
// is read from within the 7-day window; no prior-week figures are cited.
const REPORT_SECTIONS_WEEKLY = {
  executive_summary:
    "Across the week a single business-email-compromise campaign " +
    "escalated from a consent-phishing lure to durable mailbox access " +
    "and, by week's end, an attempted fraudulent payment redirect " +
    "(T1566.002, T1528, T1656). The thread is treated as one developing " +
    "intrusion, not three isolated days.",
  story_highlights: [
    "Early in the week a finance user was lured to a look-alike vendor " +
      "portal and authenticated from an unfamiliar client (T1566.002).",
    "Mid-week the same account authorised a malicious OAuth application " +
      "that requested offline mailbox-read scopes, turning the foothold " +
      "into access that survives a password reset (T1528, T1114.002).",
    "By week's end a fraudulent payment-redirect request referencing a " +
      "genuine open invoice reached the accounts-payable system (T1656).",
  ],
  notable_events: [
    "A mailbox auto-forwarding rule to an external address was created " +
      "mid-week (T1114.003), consistent with the running mailbox-access " +
      "activity rather than a standalone event.",
  ],
  baseline_observations: [
    "Initial-access and collection categories were the most active over " +
      "the window; reconnaissance held steady within the week.",
    "The finance SSO host was the top sensor by event count across the " +
      "seven days.",
  ],
  period_outlook:
    "Carry the OAuth-grant and accounts-payable thread into next week: " +
    "confirm the malicious application registration stays revoked and " +
    "watch for renewed payment-redirect attempts on the same invoices.",
};

// MONTHLY sections — a month-in-review that surfaces the durable pattern
// across the weeks of the month. The escalation and the drift call-out
// are grounded in the month's own evidence; the prior month is not quoted.
const REPORT_SECTIONS_MONTHLY = {
  executive_summary:
    "The month was characterised by a sustained exploitation campaign " +
    "against internet-facing web hosts: broad scanning early in the " +
    "month matured into a confirmed web-shell foothold and, later, " +
    "service-account credential use and a persistence attempt (T1190, " +
    "T1505.003, T1078). A mid-month reconnaissance spike stands out " +
    "against an otherwise steady baseline.",
  story_highlights: [
    "Scanning for deserialization flaws across the public web tier " +
      "opened the month with no payload landing (T1595.002).",
    "A deserialization exploit then wrote a JSP web shell to an " +
      "internet-facing host and ran reconnaissance as the application " +
      "service account (T1190, T1505.003).",
    "Late in the month the same service account read database " +
      "connection strings and attempted a scheduled-task install, " +
      "extending the foothold toward persistence (T1078, T1053.005).",
  ],
  notable_events: [
    "Internal network-service discovery from the compromised web host " +
      "(T1046) appeared after the web-shell activity, consistent with " +
      "the actor mapping the environment from its foothold.",
  ],
  baseline_observations: [
    "A reconnaissance spike mid-month cleared the drift noise threshold " +
      "and lifted the month's priority tier above its individual " +
      "stories; outside that spike, category volume was steady.",
    "Edge sensors carried the bulk of the month's event volume.",
  ],
  period_outlook:
    "Track the web-tier foothold into next month: verify the web shell " +
    "and scheduled task are removed, rotate the exposed service-account " +
    "credentials, and keep watch on the host that began internal " +
    "discovery.",
};

interface ReportRow {
  period: string;
  bucketDate: string;
  severity: number;
  likelihood: number;
  ttp: string[];
  tier: string;
  sections: Record<string, unknown>;
  inputHash: string;
}

const REPORT_ROWS: readonly ReportRow[] = [
  {
    period: REPORT_PERIOD,
    bucketDate: REPORT_BUCKET_DATE,
    severity: 0.72,
    likelihood: 0.85,
    ttp: ["T1078", "T1110.001", "T1071.001"],
    tier: "HIGH",
    sections: REPORT_SECTIONS,
    inputHash: "sha256:fixture-report-daily",
  },
  {
    period: REPORT_PERIOD_WEEKLY,
    bucketDate: REPORT_BUCKET_DATE_WEEKLY,
    severity: 0.78,
    likelihood: 0.82,
    ttp: ["T1566.002", "T1528", "T1114.002", "T1656"],
    tier: "HIGH",
    sections: REPORT_SECTIONS_WEEKLY,
    inputHash: "sha256:fixture-report-weekly",
  },
  {
    period: REPORT_PERIOD_MONTHLY,
    bucketDate: REPORT_BUCKET_DATE_MONTHLY,
    severity: 0.9,
    likelihood: 1.0,
    ttp: ["T1190", "T1505.003", "T1078", "T1046"],
    tier: "CRITICAL",
    sections: REPORT_SECTIONS_MONTHLY,
    inputHash: "sha256:fixture-report-monthly",
  },
];

/**
 * Seed the periodic report fixtures for `customerId`. Inserts the auth-DB
 * `periodic_report_state` row and the customer-DB `periodic_report_result`
 * row for the default DAILY, WEEKLY, and MONTHLY variants. Idempotent —
 * re-running upserts the same literal values so re-captures stay
 * byte-identical.
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

  for (const row of REPORT_ROWS) {
    await opts.authPool.query(
      `INSERT INTO periodic_report_state
         (customer_id, period, bucket_date, tz, status)
       VALUES ($1, $2, $3::date, $4, 'ready')
       ON CONFLICT (customer_id, period, bucket_date, tz)
       DO UPDATE SET status = 'ready'`,
      [opts.customerId, row.period, row.bucketDate, tz],
    );
  }

  const { Pool } = await import("pg");
  const pool = new Pool({
    connectionString: customerOwnerUrl(opts.customerId),
  });
  try {
    for (const row of REPORT_ROWS) {
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
                 $10, $11,
                 $12::jsonb, $13, $14::jsonb,
                 '[]'::jsonb, '[]'::jsonb, $15, NULL,
                 $16, NULL, $17::timestamptz)
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
          row.period,
          row.bucketDate,
          tz,
          REPORT_LANG,
          REPORT_MODEL_NAME,
          REPORT_MODEL,
          REPORT_MODEL_ACTUAL,
          REPORT_PROMPT_VERSION,
          row.severity,
          row.likelihood,
          JSON.stringify(row.ttp),
          row.tier,
          JSON.stringify(row.sections),
          row.inputHash,
          REPORT_REDACTION_POLICY,
          REPORT_REQUESTED_AT,
        ],
      );
    }
  } finally {
    await pool.end();
  }
}
