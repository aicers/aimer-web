// RFC 0002 amendment (#495) — long-tail analyzed-event aggregates DB tests.
//
// Exercises the universe→cited/uncited partition, the analyzed-event
// aggregate payload, the technique-clustered exemplars, and the exemplar
// `R{j}` token round-trip across the English native, native-pinned
// non-English, and translate (English-replay) paths — the surfaces the
// acceptance criteria call out.

import { join } from "node:path";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  closeAdminPool,
  createTestDatabase,
  dropTestDatabase,
  hasPostgres,
} from "@/lib/db/__tests__/db-test-helpers";
import { runMigrations } from "@/lib/db/migrate";

vi.mock("server-only", () => ({}));

const {
  buildPeriodicReportInput,
  buildCanonicalPinnedReportInput,
  buildPinnedTokenRefs,
} = await import("../report-input-builder");
const { scanReportAnalysisForLeaks } = await import("../report-token");
const { buildRangeSet } = await import("../../redaction/ranges");

const AUTH_MIGRATIONS_DIR = join(process.cwd(), "migrations", "auth");
const CUSTOMER_MIGRATIONS_DIR = join(process.cwd(), "migrations", "customer");
const AUTH_LOCK_ID = 2461;
const CUSTOMER_LOCK_ID = 2462;
const CUSTOMER_ID = "00000000-0000-0000-0000-0000000004e5";
const TZ = "Asia/Seoul";
const BUCKET = "2026-05-26";
const IN_WINDOW = "2026-05-26T02:00:00Z"; // inside the DAILY KST bucket
const NOW = "2026-05-27T00:00:00Z";
const EN = { tz: TZ, lang: "ENGLISH", modelName: "openai", model: "gpt-4o" };
const KO = { tz: TZ, lang: "KOREAN", modelName: "openai", model: "gpt-4o" };

async function seedBaselineEvent(
  pool: Pool,
  eventKey: string,
  aiceId = "aice-1",
): Promise<void> {
  await pool.query(
    `INSERT INTO baseline_event
       (baseline_version, event_key, event_time, kind, category, raw_score,
        raw_event, score_window_context, window_signals,
        scoring_weights_snapshot, source_aice_id, received_at)
     VALUES ('vA', $1::numeric, $2::timestamptz, 'k', 'malware', 0.5,
             '{}'::jsonb, '{}'::jsonb, '{}'::jsonb,
             '{}'::jsonb, $3, $2::timestamptz)`,
    [eventKey, IN_WINDOW, aiceId],
  );
}

async function seedEventResult(
  pool: Pool,
  args: {
    eventKey: string;
    lang: string;
    tier: string;
    ttpTags: string[];
    severityFactors: string[];
    likelihoodFactors: string[];
    severityScore?: number;
    likelihoodScore?: number;
    aiceId?: string;
  },
): Promise<void> {
  await pool.query(
    `INSERT INTO event_analysis_result
       (aice_id, event_key, lang, model_name, model,
        model_actual_version, prompt_version, generation,
        severity_score, likelihood_score,
        severity_factors, likelihood_factors, ttp_tags,
        priority_tier, analysis_text, event_time, redaction_policy_version, requested_by)
     VALUES ($1, $2::numeric, $3, 'openai', 'gpt-4o',
             'mv', 'pv', 1,
             $4, $5,
             $6::jsonb, $7::jsonb, $8::jsonb,
             $9, $10, '2026-05-20T00:00:00Z'::timestamptz, 'policy-A', gen_random_uuid())`,
    [
      args.aiceId ?? "aice-1",
      args.eventKey,
      args.lang,
      args.severityScore ?? 0.6,
      args.likelihoodScore ?? 0.6,
      JSON.stringify(args.severityFactors),
      JSON.stringify(args.likelihoodFactors),
      JSON.stringify(args.ttpTags),
      args.tier,
      `analysis ${args.eventKey} ${args.lang}`,
    ],
  );
}

describe.skipIf(!hasPostgres)("long-tail analyzed-event aggregates", () => {
  let authDbName: string;
  let authPool: Pool;
  let customerDbName: string;
  let customerPool: Pool;

  beforeAll(async () => {
    const auth = await createTestDatabase("long_tail_auth");
    authDbName = auth.dbName;
    authPool = auth.pool;
    await runMigrations(authPool, AUTH_MIGRATIONS_DIR, AUTH_LOCK_ID);

    const cust = await createTestDatabase("long_tail_cust");
    customerDbName = cust.dbName;
    customerPool = cust.pool;
    await runMigrations(
      customerPool,
      CUSTOMER_MIGRATIONS_DIR,
      CUSTOMER_LOCK_ID,
    );

    await authPool.query(
      `INSERT INTO customers (id, external_key, name, database_status, timezone)
       VALUES ($1, 'lt-1', 'LT Customer', 'active', $2)`,
      [CUSTOMER_ID, TZ],
    );

    // No stories → empty covered set. Three analyzed events in-window:
    //   6001 HIGH  T1            → cited (above the floor).
    //   6002 LOW   T2 (sev tok)  → uncited (LOW never cited), rep of T2.
    //   6003 LOW   T2,T3 (sentinel sev → lik tok) → uncited.
    for (const key of ["6001", "6002", "6003"]) {
      await seedBaselineEvent(customerPool, key);
    }
    await seedEventResult(customerPool, {
      eventKey: "6001",
      lang: "ENGLISH",
      tier: "HIGH",
      ttpTags: ["T1"],
      severityFactors: ["high sev <<REDACTED_IP_001>>"],
      likelihoodFactors: ["high lik"],
      severityScore: 0.9,
      likelihoodScore: 0.9,
    });
    // Korean cited leaf for 6001 (native-pinned path).
    await seedEventResult(customerPool, {
      eventKey: "6001",
      lang: "KOREAN",
      tier: "HIGH",
      ttpTags: ["T1"],
      severityFactors: ["높은 심각도 <<REDACTED_IP_001>>"],
      likelihoodFactors: ["높은 가능성"],
      severityScore: 0.9,
      likelihoodScore: 0.9,
    });
    await seedEventResult(customerPool, {
      eventKey: "6002",
      lang: "ENGLISH",
      tier: "LOW",
      ttpTags: ["T2"],
      severityFactors: ["low sev <<REDACTED_EMAIL_001>>"],
      likelihoodFactors: ["low lik"],
      severityScore: 0.5,
      likelihoodScore: 0.5,
    });
    await seedEventResult(customerPool, {
      eventKey: "6003",
      lang: "ENGLISH",
      tier: "LOW",
      ttpTags: ["T2", "T3"],
      severityFactors: ["insufficient evidence"],
      likelihoodFactors: ["fallback lik <<REDACTED_MAC_001>>"],
      severityScore: 0.2,
      likelihoodScore: 0.2,
    });
  });

  afterAll(async () => {
    await dropTestDatabase(customerDbName, customerPool);
    await dropTestDatabase(authDbName, authPool);
    await closeAdminPool();
  });

  it("partitions the universe and populates the aggregate facets", async () => {
    const built = await buildPeriodicReportInput({
      authPool,
      customerPool,
      customerId: CUSTOMER_ID,
      period: "DAILY",
      bucketDate: BUCKET,
      variant: EN,
      nowIso: NOW,
    });
    const agg = built.aimerInputs.analyzedEventAggregates;
    expect(agg).toBeDefined();
    if (!agg) return;

    // analyzedCount = full universe (3); citedCount = the HIGH leaf only.
    expect(agg.analyzedCount).toBe(3);
    expect(agg.citedCount).toBe(1);
    // tierDistribution over the FULL universe, canonical high→low order.
    expect(agg.tierDistribution).toEqual([
      { key: "HIGH", count: 1 },
      { key: "LOW", count: 2 },
    ]);
    // topTechniques over the FULL universe: T2 (6002+6003)=2, T1=1, T3=1.
    expect(agg.topTechniques).toEqual([
      { key: "T2", count: 2 },
      { key: "T1", count: 1 },
      { key: "T3", count: 1 },
    ]);
    // uncitedRollup over the UNCITED partition only (6002,6003).
    expect(agg.uncitedRollup).toEqual([
      { key: "T2", count: 2 },
      { key: "T3", count: 1 },
    ]);
  });

  it("builds technique-clustered exemplars with report-scope factor tokens", async () => {
    const built = await buildPeriodicReportInput({
      authPool,
      customerPool,
      customerId: CUSTOMER_ID,
      period: "DAILY",
      bucketDate: BUCKET,
      variant: EN,
      nowIso: NOW,
    });
    const agg = built.aimerInputs.analyzedEventAggregates;
    expect(agg).toBeDefined();
    if (!agg) return;

    // One cited event (6001) → leaf j=1; exemplar leaves appended at j=2, j=3.
    // T2 rep is 6002 (higher score than 6003); T3 rep is 6003.
    expect(agg.exemplars).toEqual([
      {
        technique: "T2",
        tier: "LOW",
        count: 2,
        factor: "low sev <<REDACTED_EMAIL_R2_001>>",
      },
      {
        // 6003's severity factor is the sentinel → falls back to likelihood.
        technique: "T3",
        tier: "LOW",
        count: 1,
        factor: "fallback lik <<REDACTED_MAC_R3_001>>",
      },
    ]);
    // Distinct rep leaves only: 6002, 6003 (in cluster order).
    expect(built.exemplarRefs.map((r) => r.event_key)).toEqual([
      "6002",
      "6003",
    ]);
    expect(built.exemplarRefs[0]).toMatchObject({
      aice_id: "aice-1",
      generation: 1,
      model_name: "openai",
      model: "gpt-4o",
    });
  });

  it("omits the section entirely when the universe is empty", async () => {
    const built = await buildPeriodicReportInput({
      authPool,
      customerPool,
      customerId: CUSTOMER_ID,
      period: "DAILY",
      // A bucket far from any seeded event → empty universe.
      bucketDate: "2026-01-01",
      variant: EN,
      nowIso: NOW,
    });
    // OMITTED, not null — the property must be absent so the input hash is
    // byte-identical to pre-change.
    expect("analyzedEventAggregates" in built.aimerInputs).toBe(false);
    expect(built.analyzedEventAggregates).toBeNull();
    expect(built.exemplarRefs).toEqual([]);
  });

  it("native-pinned non-English reuses the payload and replays exemplars at English", async () => {
    const english = await buildPeriodicReportInput({
      authPool,
      customerPool,
      customerId: CUSTOMER_ID,
      period: "DAILY",
      bucketDate: BUCKET,
      variant: EN,
      nowIso: NOW,
    });

    const pinned = await buildCanonicalPinnedReportInput({
      customerPool,
      customerId: CUSTOMER_ID,
      period: "DAILY",
      bucketDate: BUCKET,
      variant: KO,
      nowIso: NOW,
      storyRefs: english.storyRefs,
      eventRefs: english.eventRefs,
      exemplarRefs: english.exemplarRefs,
      analyzedEventAggregates: english.analyzedEventAggregates,
    });
    expect(pinned.complete).toBe(true);
    if (!pinned.complete) return;

    // The aggregate payload (counts / rollups / exemplar factor phrasing +
    // its English R{j} numbering) is reused verbatim — no re-localization.
    expect(pinned.built.aimerInputs.analyzedEventAggregates).toEqual(
      english.aimerInputs.analyzedEventAggregates,
    );
    // The cited event narrative is native Korean, NOT the English text.
    expect(pinned.built.aimerInputs.eventAnalyses[0].sections).toContain(
      "KOREAN",
    );

    // The exemplar tokens (R2/R3, minted from the English exemplar leaves)
    // appear in the pinned row's tokenRefs so the native leak scan covers
    // them. Find the exemplar refs (kind "exemplar").
    const exemplarTokenRefs = pinned.built.tokenRefs.filter(
      (r) => r.kind === "exemplar",
    );
    expect(exemplarTokenRefs).toHaveLength(2);
    const exemplarReportTokens = exemplarTokenRefs
      .flatMap((r) => r.tokens.map((t) => t.reportToken))
      .sort();
    expect(exemplarReportTokens).toEqual([
      "<<REDACTED_EMAIL_R2_001>>",
      "<<REDACTED_MAC_R3_001>>",
    ]);

    // A report narrative quoting an exemplar token passes the leak scan
    // (the exemplar token is allowed via the unioned token map).
    const scan = scanReportAnalysisForLeaks(
      "Long tail dominated by <<REDACTED_EMAIL_R2_001>> activity.",
      pinned.built.tokenRefs,
      buildRangeSet([]),
    );
    expect(scan.hasLeak).toBe(false);
  });

  it("translate path replays cited + exemplar tokens at English (buildPinnedTokenRefs)", async () => {
    const english = await buildPeriodicReportInput({
      authPool,
      customerPool,
      customerId: CUSTOMER_ID,
      period: "DAILY",
      bucketDate: BUCKET,
      variant: EN,
      nowIso: NOW,
    });

    const refs = await buildPinnedTokenRefs(
      customerPool,
      CUSTOMER_ID,
      EN,
      english.storyRefs,
      english.eventRefs,
      english.exemplarRefs,
    );
    expect(refs).not.toBeNull();
    if (refs === null) return;

    // The reconstructed refs include the exemplar tokens, so the translate
    // leak scan's allowedTokens covers an exemplar token preserved verbatim
    // through translation.
    const tokens = refs.flatMap((r) => r.tokens.map((t) => t.reportToken));
    expect(tokens).toContain("<<REDACTED_EMAIL_R2_001>>");
    expect(tokens).toContain("<<REDACTED_MAC_R3_001>>");
  });
});
