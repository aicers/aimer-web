// Deterministic fixture seed for the RFC 0002 Phase 1 story analysis
// page captures (#331).
//
// Manual screenshots must be reproducible locally and in CI, so the
// captures are driven from a fixed synthetic seed rather than live
// operator review data (which rotates and could surface customer PII in
// narratives). Every value below is a literal constant: re-running the
// capture spec produces byte-identical PNGs.
//
// The seed inserts the minimum the page render consults:
//   - `story_analysis_state` (auth DB) — the loader returns `not_found`
//     without this row.
//   - `story_analysis_result` (customer DB) — supplies every rendered
//     field. `input_event_refs` is empty so the loader skips token
//     restoration entirely (no `event_redaction_map` / OpenBao Transit
//     dependency), and the narrative text is written as clean plaintext
//     with no `<<REDACTED_*_E{i}_*>>` tokens.
//
// Two tiers are seeded:
//   - HIGH  — drives `story-detail-high.{en,ko}.png` and
//     `story-regenerate-modal.{en,ko}.png`. Factor rows render inline.
//   - LOW   — drives `story-detail-low.{en,ko}.png`. The page collapses
//     the factor rows behind `<details>` for LOW tier (#333 item 1), so
//     both factor arrays are populated to exercise that disclosure.
//
// The narrative content is synthetic and pre-redacted (no real PII); it
// is hand-written rather than sourced from a live cohort because the
// gauntlet cohort is empty at authoring time. Either sourcing path is
// acceptable per the issue — this PR took the synthetic-seed path.

import type { Pool } from "pg";
import { customerOwnerUrl } from "./customer-db";

/** Default `(lang, model_name, model)` variant resolved by the loader. */
export const STORY_LANG = "ENGLISH";
export const STORY_MODEL_NAME = "openai";
export const STORY_MODEL = "gpt-4o";

const STORY_MODEL_ACTUAL = "gpt-4o-2024-08-06";
const STORY_PROMPT_VERSION = "aimer-prompt-v3";
// Fixed so the captured "Requested at" field is byte-stable. The page
// renders `requested_at.toISOString()`; pinning the seeded value avoids
// any clock mocking.
const STORY_REQUESTED_AT = "2025-01-15T12:00:00Z";
const STORY_REDACTION_POLICY = "engine:0.0.0|ranges:none";

export interface StoryFixtureTier {
  /** `story_id` (BIGINT) as a string. */
  storyId: string;
  tier: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";
  severityScore: number;
  likelihoodScore: number;
  severityFactors: string[];
  likelihoodFactors: string[];
  ttpTags: string[];
  analysisText: string;
}

// Severity 0.720, likelihood 0.850 ⇒ HIGH via the RFC 0002 4×4 matrix
// (0.6 ≤ S < 0.8, L ≥ 0.8). All factor rows render inline and the TTP
// chip row is populated so the capture shows the expressive layout.
export const STORY_FIXTURE_HIGH: StoryFixtureTier = {
  storyId: "4001",
  tier: "HIGH",
  severityScore: 0.72,
  likelihoodScore: 0.85,
  severityFactors: [
    "privileged service account targeted",
    "credential reuse observed across three hosts",
    "lateral movement toward a domain controller",
    "successful sign-in from an anomalous geography",
  ],
  likelihoodFactors: [
    "matches the known brute-force baseline for this aice",
    "burst of failed attempts immediately preceded success",
    "client fingerprint absent from the rest of the fleet",
  ],
  ttpTags: ["T1078", "T1110.001", "T1059.001", "T1071.001"],
  // Real Markdown (headings, lists, inline code) so the capture
  // exercises the shared Markdown renderer (#382).
  analysisText:
    "## Summary\n\n" +
    "The story groups a credential-stuffing burst against the SSO " +
    "endpoint with a follow-on interactive sign-in from the same " +
    "source. 412 failed authentications in 60 seconds preceded a " +
    "single success on a privileged service account, after which the " +
    "session pivoted toward an internal domain controller.\n\n" +
    "Taken together the members describe an **account-takeover " +
    "attempt** that reached an initial foothold rather than isolated " +
    "noise. The reused credential and the lateral movement raise the " +
    "severity above a single-host compromise.\n\n" +
    "## Recommended action\n\n" +
    "- revoke the affected account's active sessions\n" +
    "- force a credential reset\n" +
    "- review `domain-controller` authentication logs for the source " +
    "host over the surrounding window",
};

// Severity 0.350, likelihood 0.300 ⇒ LOW via the matrix (S < 0.4). The
// factor rows are still populated so the LOW-tier `<details>` collapse
// has content to disclose in the capture.
export const STORY_FIXTURE_LOW: StoryFixtureTier = {
  storyId: "4002",
  tier: "LOW",
  severityScore: 0.35,
  likelihoodScore: 0.3,
  severityFactors: [
    "single low-value public endpoint touched",
    "no privileged credential involved",
  ],
  likelihoodFactors: [
    "consistent with routine internet background scanning",
    "no successful authentication observed",
  ],
  ttpTags: ["T1595.001"],
  analysisText:
    "## Summary\n\n" +
    "The story collects unauthenticated probe requests against a " +
    "public health-check path. The requests came from a rotating set " +
    "of source addresses and never advanced past an `HTTP 404`.\n\n" +
    "The pattern matches commodity internet scanning rather than a " +
    "targeted attempt. No credential was presented and no session was " +
    "established, so the likelihood of a real compromise is low.\n\n" +
    "## Recommended action\n\n" +
    "No immediate response required; the events are retained for trend " +
    "baselining.",
};

/**
 * Seed one or more story-analysis tiers for `customerId`. Inserts the
 * auth-DB `story_analysis_state` row and the customer-DB
 * `story_analysis_result` row for each tier. Idempotent — re-running
 * upserts the same literal values, so re-captures stay byte-identical.
 *
 * The customer DB must already be provisioned and migrated (see
 * `provisionAnalysisCustomerDb`). The auth pool is passed in by the
 * caller (the spec's shared test pool).
 */
export async function seedStoryAnalysisFixture(opts: {
  authPool: Pool;
  customerId: string;
  tiers: readonly StoryFixtureTier[];
}): Promise<void> {
  for (const tier of opts.tiers) {
    await opts.authPool.query(
      `INSERT INTO story_analysis_state (customer_id, story_id, status)
       VALUES ($1, $2::bigint, 'ready')
       ON CONFLICT (customer_id, story_id)
       DO UPDATE SET status = 'ready'`,
      [opts.customerId, tier.storyId],
    );
  }

  const { Pool } = await import("pg");
  const pool = new Pool({
    connectionString: customerOwnerUrl(opts.customerId),
  });
  try {
    for (const tier of opts.tiers) {
      await pool.query(
        `INSERT INTO story_analysis_result
           (customer_id, story_id, lang, model_name, model,
            model_actual_version, prompt_version, generation,
            severity_score, likelihood_score,
            severity_factors, likelihood_factors, ttp_tags,
            priority_tier, analysis_text, input_event_refs, input_fact_refs,
            input_hash, redaction_policy_version, requested_by, requested_at)
         VALUES ($1, $2::bigint, $3, $4, $5,
                 $6, $7, 1,
                 $8, $9,
                 $10::jsonb, $11::jsonb, $12::jsonb,
                 $13, $14, '[]'::jsonb, '[]'::jsonb, $15,
                 $16, NULL, $17::timestamptz)
         ON CONFLICT (customer_id, story_id, lang, model_name, model, generation)
         DO UPDATE SET
           severity_score     = EXCLUDED.severity_score,
           likelihood_score   = EXCLUDED.likelihood_score,
           severity_factors   = EXCLUDED.severity_factors,
           likelihood_factors = EXCLUDED.likelihood_factors,
           ttp_tags           = EXCLUDED.ttp_tags,
           priority_tier      = EXCLUDED.priority_tier,
           analysis_text      = EXCLUDED.analysis_text,
           requested_at       = EXCLUDED.requested_at`,
        [
          opts.customerId,
          tier.storyId,
          STORY_LANG,
          STORY_MODEL_NAME,
          STORY_MODEL,
          STORY_MODEL_ACTUAL,
          STORY_PROMPT_VERSION,
          tier.severityScore,
          tier.likelihoodScore,
          JSON.stringify(tier.severityFactors),
          JSON.stringify(tier.likelihoodFactors),
          JSON.stringify(tier.ttpTags),
          tier.tier,
          tier.analysisText,
          `sha256:fixture-${tier.tier.toLowerCase()}`,
          STORY_REDACTION_POLICY,
          STORY_REQUESTED_AT,
        ],
      );
    }
  } finally {
    await pool.end();
  }
}
