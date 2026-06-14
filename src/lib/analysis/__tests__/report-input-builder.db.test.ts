// RFC 0002 Phase 2 (#297) — periodic report input builder DB tests.
//
// Covers the issue's gates:
//   - Top events baseline_event dedupe (round-14 item 2)
//   - Baseline aggregator dedupe (count/distribution not inflated)
//   - Story freshness filter (round-14 item 3): dirty/pending/archived
//     state excludes the story even with a live result row
//   - Variant filter (round-14 item 2): a KR report ignores EN leaves
//   - Dedup across stories/events (RFC §"Dedup across Phase 1 and 2")

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

const { buildPeriodicReportInput } = await import("../report-input-builder");

const AUTH_MIGRATIONS_DIR = join(process.cwd(), "migrations", "auth");
const CUSTOMER_MIGRATIONS_DIR = join(process.cwd(), "migrations", "customer");
const AUTH_LOCK_ID = 2401;
const CUSTOMER_LOCK_ID = 2402;
const CUSTOMER_ID = "00000000-0000-0000-0000-0000000000d1";
const TZ = "Asia/Seoul";
// DAILY bucket 2026-05-26 in Asia/Seoul → [2026-05-25T15:00Z, 2026-05-26T15:00Z).
const BUCKET = "2026-05-26";
const IN_WINDOW = "2026-05-26T02:00:00Z"; // 11:00 KST, inside the day
// 01:00 KST on 2026-05-27 — past the bucket's [.., 2026-05-26T15:00Z) end,
// and outside the prior day too. Used to prove dedupe-before-window.
const OUT_OF_WINDOW = "2026-05-26T16:00:00Z";
const EN = { tz: TZ, lang: "ENGLISH", modelName: "openai", model: "gpt-4o" };
// Korean variant of the same model — used by the #580 bilingual-citation
// regression. A separate report bucket far from the beforeAll fixtures isolates
// the one bilingual story under test.
const KO = { tz: TZ, lang: "KOREAN", modelName: "openai", model: "gpt-4o" };
const BICITE_BUCKET = "2026-05-20";
const BICITE_WINDOW = "2026-05-20T02:00:00Z";

async function seedStory(
  customerPool: Pool,
  storyId: string,
  version: string,
  receivedAt: string,
): Promise<void> {
  await customerPool.query(
    `INSERT INTO story
       (story_id, story_version, kind, time_window_start, time_window_end,
        summary_payload, source_aice_id, received_at)
     VALUES ($1::bigint, $2, 'auto_correlated',
             $3::timestamptz, ($3::timestamptz + INTERVAL '10 minutes'),
             '{}'::jsonb, 'aice-1', $3::timestamptz)`,
    [storyId, version, receivedAt],
  );
}

async function seedStoryResult(
  customerPool: Pool,
  storyId: string,
  variant: { lang: string; modelName: string; model: string },
  tier: string,
  analysis: string,
  // RFC 0005 — bare CVE ids stored as the enriched `cve_refs` record shape
  // (`{ cve }` is the minimal record `parseCveRefs` accepts).
  cveRefs: string[] = [],
): Promise<void> {
  await customerPool.query(
    `INSERT INTO story_analysis_result
       (customer_id, story_id, lang, model_name, model,
        model_actual_version, prompt_version, generation,
        severity_score, likelihood_score,
        severity_factors, likelihood_factors, ttp_tags, cve_refs,
        priority_tier, analysis_text, input_event_refs, input_fact_refs,
        input_hash, redaction_policy_version)
     VALUES ($1, $2::bigint, $3, $4, $5,
             'mv', 'pv', 1,
             0.8, 0.7,
             '[]'::jsonb, '[]'::jsonb, '["T1078"]'::jsonb, $8::jsonb,
             $6, $7, '[]'::jsonb, '[]'::jsonb, 'h', 'policy-A')`,
    [
      CUSTOMER_ID,
      storyId,
      variant.lang,
      variant.modelName,
      variant.model,
      tier,
      analysis,
      JSON.stringify(cveRefs.map((cve) => ({ cve }))),
    ],
  );
}

async function seedStoryMember(
  customerPool: Pool,
  storyId: string,
  version: string,
  eventKey: string,
): Promise<void> {
  await customerPool.query(
    `INSERT INTO story_member
       (story_id, story_version, member_event_key, role, event)
     VALUES ($1::bigint, $2, $3::numeric, 'primary', '{}'::jsonb)`,
    [storyId, version, eventKey],
  );
}

async function seedBaselineEvent(
  customerPool: Pool,
  baselineVersion: string,
  eventKey: string,
  eventTime: string,
  category: string | null,
  receivedAt: string,
  aiceId = "aice-1",
): Promise<void> {
  await customerPool.query(
    `INSERT INTO baseline_event
       (baseline_version, event_key, event_time, kind, category, raw_score,
        raw_event, score_window_context, window_signals,
        scoring_weights_snapshot, source_aice_id, received_at)
     VALUES ($1, $2::numeric, $3::timestamptz, 'k', $4, 0.5,
             '{}'::jsonb, '{}'::jsonb, '{}'::jsonb,
             '{}'::jsonb, $6, $5::timestamptz)`,
    [baselineVersion, eventKey, eventTime, category, receivedAt, aiceId],
  );
}

async function seedEventResult(
  customerPool: Pool,
  eventKey: string,
  variant: { lang: string; modelName: string; model: string },
  tier: string,
  analysis: string,
  aiceId = "aice-1",
  // RFC 0005 — bare CVE ids stored as the enriched `cve_refs` record shape.
  cveRefs: string[] = [],
): Promise<void> {
  await customerPool.query(
    `INSERT INTO event_analysis_result
       (aice_id, event_key, lang, model_name, model,
        model_actual_version, prompt_version, generation,
        severity_score, likelihood_score,
        severity_factors, likelihood_factors, ttp_tags, cve_refs,
        priority_tier, analysis_text, event_time, redaction_policy_version, requested_by)
     VALUES ($7, $1::numeric, $2, $3, $4,
             'mv', 'pv', 1,
             0.6, 0.6,
             '[]'::jsonb, '[]'::jsonb, '["T1110"]'::jsonb, $8::jsonb,
             $5, $6, '2026-05-20T00:00:00Z'::timestamptz, 'policy-A', gen_random_uuid())`,
    [
      eventKey,
      variant.lang,
      variant.modelName,
      variant.model,
      tier,
      analysis,
      aiceId,
      JSON.stringify(cveRefs.map((cve) => ({ cve }))),
    ],
  );
}

async function seedState(
  authPool: Pool,
  storyId: string,
  status: string,
): Promise<void> {
  await authPool.query(
    `INSERT INTO story_analysis_state (customer_id, story_id, status)
     VALUES ($1, $2::bigint, $3)
     ON CONFLICT (customer_id, story_id)
     DO UPDATE SET status = EXCLUDED.status`,
    [CUSTOMER_ID, storyId, status],
  );
}

describe.skipIf(!hasPostgres)(
  "periodic report input builder (cross-DB)",
  () => {
    let authDbName: string;
    let authPool: Pool;
    let customerDbName: string;
    let customerPool: Pool;

    beforeAll(async () => {
      const auth = await createTestDatabase("report_input_auth");
      authDbName = auth.dbName;
      authPool = auth.pool;
      await runMigrations(authPool, AUTH_MIGRATIONS_DIR, AUTH_LOCK_ID);

      const cust = await createTestDatabase("report_input_cust");
      customerDbName = cust.dbName;
      customerPool = cust.pool;
      await runMigrations(
        customerPool,
        CUSTOMER_MIGRATIONS_DIR,
        CUSTOMER_LOCK_ID,
      );

      await authPool.query(
        `INSERT INTO customers (id, external_key, name, database_status, timezone)
       VALUES ($1, 'rib-1', 'RIB Customer', 'active', $2)`,
        [CUSTOMER_ID, TZ],
      );

      // Story 7001: ready + EN result + one member event (key 5001).
      await seedStory(customerPool, "7001", "v1", IN_WINDOW);
      await seedStory(customerPool, "7001", "v2", IN_WINDOW); // canonical
      await seedStoryResult(customerPool, "7001", EN, "HIGH", "story 7001 EN", [
        "CVE-2024-0001",
      ]);
      await seedStoryMember(customerPool, "7001", "v2", "5001");
      await seedState(authPool, "7001", "ready");

      // Story 7002: DIRTY state but a live EN result exists → excluded.
      await seedStory(customerPool, "7002", "v1", IN_WINDOW);
      await seedStoryResult(
        customerPool,
        "7002",
        EN,
        "CRITICAL",
        "story 7002 EN",
      );
      await seedState(authPool, "7002", "dirty");

      // baseline_event 5001 (story member) — rebaselined twice.
      await seedBaselineEvent(
        customerPool,
        "vA",
        "5001",
        IN_WINDOW,
        "recon",
        IN_WINDOW,
      );
      await seedBaselineEvent(
        customerPool,
        "vB",
        "5001",
        IN_WINDOW,
        "recon",
        "2026-05-26T03:00:00Z",
      );
      // baseline_event 6001 (standalone event) — also rebaselined twice.
      await seedBaselineEvent(
        customerPool,
        "vA",
        "6001",
        IN_WINDOW,
        "malware",
        IN_WINDOW,
      );
      await seedBaselineEvent(
        customerPool,
        "vB",
        "6001",
        IN_WINDOW,
        "malware",
        "2026-05-26T03:00:00Z",
      );

      // baseline_event 6002 — the canonical (latest received_at) row is
      // OUT of the bucket window, while an older duplicate is in-window.
      // Dedupe-before-window must anchor on the canonical out-of-window
      // event_time and exclude 6002 entirely (round-14 item 2 / #297
      // review round 1, item 1).
      await seedBaselineEvent(
        customerPool,
        "vA",
        "6002",
        IN_WINDOW, // older duplicate, in-window
        "exfil",
        IN_WINDOW,
      );
      await seedBaselineEvent(
        customerPool,
        "vB",
        "6002",
        OUT_OF_WINDOW, // canonical (latest received_at), out-of-window
        "exfil",
        "2026-05-26T03:00:00Z",
      );

      // Event result for 6001 (EN) → eligible top event. Carries one CVE
      // that overlaps story 7001's (dedup) plus one unique to the event.
      await seedEventResult(
        customerPool,
        "6001",
        EN,
        "MEDIUM",
        "event 6001 EN",
        "aice-1",
        ["CVE-2024-1234", "CVE-2024-0001"],
      );
      // Event result for 6002 (EN) → would be eligible if the older
      // in-window duplicate were (wrongly) chosen as canonical.
      await seedEventResult(
        customerPool,
        "6002",
        EN,
        "CRITICAL",
        "event 6002 EN",
      );
      // Event result for 5001 (EN) → excluded because covered by story 7001.
      await seedEventResult(customerPool, "5001", EN, "HIGH", "event 5001 EN");
      // Event result for 6001 in KOREAN → excluded by variant filter on EN run.
      await seedEventResult(
        customerPool,
        "6001",
        { lang: "KOREAN", modelName: "openai", model: "gpt-4o" },
        "CRITICAL",
        "event 6001 KR",
      );
    });

    afterAll(async () => {
      await dropTestDatabase(authDbName, authPool);
      await dropTestDatabase(customerDbName, customerPool);
      await closeAdminPool();
    });

    it("selects only fresh stories and excludes story-covered + cross-variant events", async () => {
      const res = await buildPeriodicReportInput({
        authPool,
        customerPool,
        customerId: CUSTOMER_ID,
        period: "DAILY",
        bucketDate: BUCKET,
        variant: EN,
        nowIso: "2026-05-27T00:00:00Z",
      });

      // Story freshness: 7001 (ready) included, 7002 (dirty) excluded.
      expect(res.storyRefs.map((r) => r.story_id)).toEqual(["7001"]);

      // Events: 6001 included once; 5001 excluded (story member);
      // KR variant of 6001 excluded by variant filter.
      expect(res.eventRefs.map((r) => `${r.aice_id}/${r.event_key}`)).toEqual([
        "aice-1/6001",
      ]);

      // TTP union across the one story (T1078) and one event (T1110).
      expect(res.aggregateTtpTags).toEqual(["T1078", "T1110"]);

      // RFC 0005 — CVE refs propagate from the leaf `cve_refs` records onto
      // each leaf input, and the bundle aggregate is the dedup'd sorted union
      // (story CVE-2024-0001 + event {CVE-2024-1234, CVE-2024-0001}).
      expect(res.aimerInputs.storyAnalyses[0].cveRefs).toEqual([
        "CVE-2024-0001",
      ]);
      expect(res.aimerInputs.eventAnalyses[0].cveRefs).toEqual([
        "CVE-2024-1234",
        "CVE-2024-0001",
      ]);
      expect(res.aggregateCveRefs).toEqual(["CVE-2024-0001", "CVE-2024-1234"]);
      expect(res.aimerInputs.aggregateCveRefs).toEqual([
        "CVE-2024-0001",
        "CVE-2024-1234",
      ]);

      // Redaction policy agrees (policy-A on every consumed leaf).
      expect(res.redaction).toEqual({ kind: "ok", version: "policy-A" });
    });

    it("baseline aggregator dedupes rebaselined events (no count inflation)", async () => {
      const res = await buildPeriodicReportInput({
        authPool,
        customerPool,
        customerId: CUSTOMER_ID,
        period: "DAILY",
        bucketDate: BUCKET,
        variant: EN,
        nowIso: "2026-05-27T00:00:00Z",
      });
      const agg = res.aimerInputs.baselineAggregates;
      // Two distinct events (5001, 6001), each rebaselined twice — the
      // deduped window total must be 2, not 4. Event 6002's canonical row is
      // out-of-window, so it is excluded.
      expect(agg.totals.events).toBe(2);
      // Both baseline events share source_aice_id 'aice-1' → exactly one
      // sensor with count 2; ordering is deterministic so the order-
      // sensitive input_hash is stable across plans/runs (#297 round 4 2).
      expect(agg.topSensors).toEqual([{ key: "aice-1", count: 2 }]);
      // Two canonical stories (7001, 7002) overlap the bucket window.
      expect(agg.totals.stories).toBe(2);
      // Techniques aggregated from the cited leaves: story 7001 (T1078) and
      // event 6001 (T1110), count desc then ID asc.
      expect(agg.topTechniques).toEqual([
        { key: "T1078", count: 1 },
        { key: "T1110", count: 1 },
      ]);
    });

    it("excludes an event whose canonical baseline row is out-of-window", async () => {
      // Event 6002 has an older in-window duplicate but a newer canonical
      // row that falls outside the bucket. Dedupe-before-window must anchor
      // on the canonical event_time and drop 6002 from Top events — even
      // though its leaf is CRITICAL and would otherwise sort first.
      const res = await buildPeriodicReportInput({
        authPool,
        customerPool,
        customerId: CUSTOMER_ID,
        period: "DAILY",
        bucketDate: BUCKET,
        variant: EN,
        nowIso: "2026-05-27T00:00:00Z",
      });
      const keys = res.eventRefs.map((r) => r.event_key);
      expect(keys).toContain("6001");
      expect(keys).not.toContain("6002");
    });

    it("a KOREAN report ignores ENGLISH leaves (variant isolation)", async () => {
      const res = await buildPeriodicReportInput({
        authPool,
        customerPool,
        customerId: CUSTOMER_ID,
        period: "DAILY",
        bucketDate: BUCKET,
        variant: {
          tz: TZ,
          lang: "KOREAN",
          modelName: "openai",
          model: "gpt-4o",
        },
        nowIso: "2026-05-27T00:00:00Z",
      });
      // No KR story result exists, so no stories. The KR event 6001 leaf
      // exists and is not story-covered (no KR story), so it is selected.
      expect(res.storyRefs).toEqual([]);
      expect(res.eventRefs.map((r) => r.event_key)).toEqual(["6001"]);
    });

    // Appended last so the same-key events seeded here cannot bleed into the
    // exact-match `eventRefs` assertions above (tests run in definition order
    // against the shared DB).
    it("emits a distinct aice_id:event_key composite eventRef per AICE source sharing a key", async () => {
      // Same numeric event_key 7777 from two different AICE sources, both
      // in-window and not story-covered. A bare event_key would make their
      // wire references collide; the composite must keep them distinct so
      // aimer's narrative can be checked against `input_event_refs`.
      for (const aice of ["aice-1", "aice-2"]) {
        await seedBaselineEvent(
          customerPool,
          `v-${aice}`,
          "7777",
          IN_WINDOW,
          "malware",
          IN_WINDOW,
          aice,
        );
        await seedEventResult(
          customerPool,
          "7777",
          EN,
          "HIGH",
          `event 7777 ${aice}`,
          aice,
        );
      }

      const res = await buildPeriodicReportInput({
        authPool,
        customerPool,
        customerId: CUSTOMER_ID,
        period: "DAILY",
        bucketDate: BUCKET,
        variant: EN,
        nowIso: "2026-05-27T00:00:00Z",
      });

      const refs = res.aimerInputs.eventAnalyses.map((e) => e.eventRef);
      expect(refs).toContain("aice-1:7777");
      expect(refs).toContain("aice-2:7777");
      // No two leaves share a wire reference, even when they share a key.
      expect(new Set(refs).size).toBe(refs.length);
    });

    // RFC 0002 Phase 3 (#298 F2) — the WEEKLY/MONTHLY window length is the
    // core Phase 3 input-builder change. Prove that an event seeded several
    // days into the week/month is OUT of the one-day DAILY bucket anchored
    // at the same date but IN of the 7-day / calendar-month window, so the
    // per-period interval in `resolveWindows` is actually selected.
    it("selects events across the longer WEEKLY / MONTHLY window that a DAILY bucket excludes", async () => {
      // 2026-05-29 11:00 KST — Friday of the week starting Mon 2026-05-25,
      // and within May. Outside the single day 2026-05-25.
      const MID_PERIOD = "2026-05-29T02:00:00Z";
      await seedBaselineEvent(
        customerPool,
        "v-9001",
        "9001",
        MID_PERIOD,
        "malware",
        MID_PERIOD,
      );
      await seedEventResult(customerPool, "9001", EN, "HIGH", "event 9001 EN");

      // WEEKLY bucket = Monday 2026-05-25; window [2026-05-25, 2026-06-01).
      const weekly = await buildPeriodicReportInput({
        authPool,
        customerPool,
        customerId: CUSTOMER_ID,
        period: "WEEKLY",
        bucketDate: "2026-05-25",
        variant: EN,
        nowIso: "2026-06-02T00:00:00Z",
      });
      expect(weekly.eventRefs.map((r) => r.event_key)).toContain("9001");

      // MONTHLY bucket = 2026-05-01; window [2026-05-01, 2026-06-01).
      const monthly = await buildPeriodicReportInput({
        authPool,
        customerPool,
        customerId: CUSTOMER_ID,
        period: "MONTHLY",
        bucketDate: "2026-05-01",
        variant: EN,
        nowIso: "2026-06-02T00:00:00Z",
      });
      expect(monthly.eventRefs.map((r) => r.event_key)).toContain("9001");

      // The same event against the one-day DAILY bucket at the week anchor
      // is excluded — proving the longer interval, not a wider default, is
      // what pulls 9001 in.
      const daily = await buildPeriodicReportInput({
        authPool,
        customerPool,
        customerId: CUSTOMER_ID,
        period: "DAILY",
        bucketDate: "2026-05-25",
        variant: EN,
        nowIso: "2026-06-02T00:00:00Z",
      });
      expect(daily.eventRefs.map((r) => r.event_key)).not.toContain("9001");
    });

    // #580 — a periodic report citing a BILINGUAL story leaf rolls up
    // identical aggregate scores / tier / TTP regardless of the report's
    // displayed language. The user-language story row copies the English
    // canonical's numeric scores verbatim (only narrative + factor phrases
    // differ), so the report's leaf roll-up — and therefore top-K selection —
    // is language-invariant. This is the regression the issue mandates without
    // changing report code: the bilingual leaves merely activate the existing
    // native non-English report path.
    it("rolls up consistent scores/tier when citing a bilingual story across display languages (#580)", async () => {
      // A story isolated to its own DAILY bucket so it is the only cited leaf.
      await seedStory(customerPool, "7580", "v1", BICITE_WINDOW);
      await seedStoryMember(customerPool, "7580", "v1", "55800");
      // English canonical + Korean translated row: seedStoryResult hardcodes
      // identical scores (0.8 / 0.7) and TTP (T1078) for both — exactly the
      // bilingual contract (the translated row copies the numbers, differing
      // only in narrative text).
      await seedStoryResult(customerPool, "7580", EN, "HIGH", "story 7580 EN", [
        "CVE-2024-5580",
      ]);
      await seedStoryResult(
        customerPool,
        "7580",
        KO,
        "HIGH",
        "스토리 7580 KO",
        ["CVE-2024-5580"],
      );
      await seedState(authPool, "7580", "ready");

      const en = await buildPeriodicReportInput({
        authPool,
        customerPool,
        customerId: CUSTOMER_ID,
        period: "DAILY",
        bucketDate: BICITE_BUCKET,
        variant: EN,
        nowIso: "2026-05-21T00:00:00Z",
      });
      const ko = await buildPeriodicReportInput({
        authPool,
        customerPool,
        customerId: CUSTOMER_ID,
        period: "DAILY",
        bucketDate: BICITE_BUCKET,
        variant: KO,
        nowIso: "2026-05-21T00:00:00Z",
      });

      // The same story leaf is cited in both languages...
      expect(en.storyRefs.map((r) => r.story_id)).toEqual(["7580"]);
      expect(ko.storyRefs.map((r) => r.story_id)).toEqual(["7580"]);
      // ...and the language-invariant roll-up is byte-identical across both.
      expect(ko.aggregateSeverityScore).toBe(en.aggregateSeverityScore);
      expect(ko.aggregateLikelihoodScore).toBe(en.aggregateLikelihoodScore);
      expect(ko.priorityTier).toBe(en.priorityTier);
      expect(ko.aggregateTtpTags).toEqual(en.aggregateTtpTags);
      // RFC 0005 — aggregate CVE refs are language-invariant too.
      expect(en.aggregateCveRefs).toEqual(["CVE-2024-5580"]);
      expect(ko.aggregateCveRefs).toEqual(en.aggregateCveRefs);
    });
  },
);

// #494 — event-leaf citation cut: tier-guaranteed (CRITICAL/HIGH) + MEDIUM
// fill under a hard ceiling `M`, with LOW never cited individually. A fresh
// customer DB so the seeded tier mix is the only event set; each scenario
// uses its own DAILY bucket so per-day window isolation keeps the seeds from
// bleeding across the shared-DB cases.
describe.skipIf(!hasPostgres)("#494 event-leaf citation cut", () => {
  const CUT_CUSTOMER_ID = "00000000-0000-0000-0000-0000000000d2";
  const CUT_AUTH_LOCK_ID = 2403;
  const CUT_CUSTOMER_LOCK_ID = 2404;
  let authDbName: string;
  let authPool: Pool;
  let customerDbName: string;
  let customerPool: Pool;

  // Seed a standalone event leaf (baseline_event + EN event_analysis_result)
  // at the given tier/score, at 11:00 KST on `day` so it lands inside that
  // day's DAILY bucket window. Unique numeric `eventKey` keeps the
  // dedupe-by-(aice_id, event_key) from collapsing leaves across scenarios.
  async function seedEvt(
    eventKey: string,
    tier: string,
    severity: number,
    likelihood: number,
    day: string,
  ): Promise<void> {
    const at = `${day}T02:00:00Z`;
    await customerPool.query(
      `INSERT INTO baseline_event
         (baseline_version, event_key, event_time, kind, category, raw_score,
          raw_event, score_window_context, window_signals,
          scoring_weights_snapshot, source_aice_id, received_at)
       VALUES ('vA', $1::numeric, $2::timestamptz, 'k', 'recon', 0.5,
               '{}'::jsonb, '{}'::jsonb, '{}'::jsonb,
               '{}'::jsonb, 'aice-1', $2::timestamptz)`,
      [eventKey, at],
    );
    await customerPool.query(
      `INSERT INTO event_analysis_result
         (aice_id, event_key, lang, model_name, model,
          model_actual_version, prompt_version, generation,
          severity_score, likelihood_score,
          severity_factors, likelihood_factors, ttp_tags,
          priority_tier, analysis_text, event_time, redaction_policy_version, requested_by)
       VALUES ('aice-1', $1::numeric, 'ENGLISH', 'openai', 'gpt-4o',
               'mv', 'pv', 1,
               $2, $3,
               '[]'::jsonb, '[]'::jsonb, '["T1110"]'::jsonb,
               $4, $5, '2026-05-20T00:00:00Z'::timestamptz, 'policy-A', gen_random_uuid())`,
      [eventKey, severity, likelihood, tier, `event ${eventKey}`],
    );
  }

  async function citedKeys(bucketDate: string, m: number): Promise<string[]> {
    const res = await buildPeriodicReportInput({
      authPool,
      customerPool,
      customerId: CUT_CUSTOMER_ID,
      period: "DAILY",
      bucketDate,
      variant: EN,
      nowIso: `${bucketDate}T20:00:00Z`,
      topEventsK: m,
    });
    return res.eventRefs.map((r) => r.event_key);
  }

  beforeAll(async () => {
    const auth = await createTestDatabase("report_cut_auth");
    authDbName = auth.dbName;
    authPool = auth.pool;
    await runMigrations(authPool, AUTH_MIGRATIONS_DIR, CUT_AUTH_LOCK_ID);

    const cust = await createTestDatabase("report_cut_cust");
    customerDbName = cust.dbName;
    customerPool = cust.pool;
    await runMigrations(
      customerPool,
      CUSTOMER_MIGRATIONS_DIR,
      CUT_CUSTOMER_LOCK_ID,
    );

    await authPool.query(
      `INSERT INTO customers (id, external_key, name, database_status, timezone)
       VALUES ($1, 'cut-1', 'Cut Customer', 'active', $2)`,
      [CUT_CUSTOMER_ID, TZ],
    );

    // Under-ceiling day (M=3): CRITICAL + HIGH (=2 < 3) guaranteed, one MEDIUM
    // fills the third slot (the higher-scored one), the lower MEDIUM and the
    // LOW are excluded.
    await seedEvt("300", "CRITICAL", 0.9, 0.9, "2026-06-01");
    await seedEvt("301", "HIGH", 0.8, 0.8, "2026-06-01");
    await seedEvt("302", "MEDIUM", 0.6, 0.6, "2026-06-01"); // sum 1.2 — fills
    await seedEvt("303", "MEDIUM", 0.3, 0.3, "2026-06-01"); // sum 0.6 — squeezed
    await seedEvt("304", "LOW", 0.1, 0.1, "2026-06-01"); // never cited

    // Exactly-ceiling day (M=2): CRITICAL + HIGH == M, so the MEDIUM is
    // squeezed out (no free slots) and LOW is excluded.
    await seedEvt("310", "CRITICAL", 0.9, 0.9, "2026-06-02");
    await seedEvt("311", "HIGH", 0.8, 0.8, "2026-06-02");
    await seedEvt("312", "MEDIUM", 0.6, 0.6, "2026-06-02");
    await seedEvt("313", "LOW", 0.1, 0.1, "2026-06-02");

    // Overflow day (M=2): three CRITICAL/HIGH leaves exceed M; exactly the
    // top-2 by ranking are cited, the third CRITICAL/HIGH leaf and the MEDIUM
    // are dropped (recoverable as full-set − cited for #495).
    await seedEvt("320", "CRITICAL", 0.95, 0.95, "2026-06-03"); // sum 1.90
    await seedEvt("321", "CRITICAL", 0.85, 0.85, "2026-06-03"); // sum 1.70
    await seedEvt("322", "HIGH", 0.8, 0.8, "2026-06-03"); // sum 1.60 — overflow
    await seedEvt("323", "MEDIUM", 0.6, 0.6, "2026-06-03"); // not cited

    // Quiet all-LOW day: every leaf is LOW, so nothing is cited (no padding).
    await seedEvt("330", "LOW", 0.2, 0.2, "2026-06-04");
    await seedEvt("331", "LOW", 0.1, 0.1, "2026-06-04");
    await seedEvt("332", "LOW", 0.05, 0.05, "2026-06-04");
  });

  afterAll(async () => {
    await dropTestDatabase(authDbName, authPool);
    await dropTestDatabase(customerDbName, customerPool);
    await closeAdminPool();
  });

  it("fills with MEDIUM under the ceiling and excludes LOW (CRITICAL/HIGH < M)", async () => {
    // M=3: CRITICAL(300) + HIGH(301) guaranteed, one MEDIUM(302) fills the
    // third slot by ranking; the lower MEDIUM(303) and LOW(304) are excluded.
    expect(await citedKeys("2026-06-01", 3)).toEqual(["300", "301", "302"]);
  });

  it("yields empty aggregateCveRefs when no leaf carries a CVE (RFC 0005)", async () => {
    // The cut-suite leaves are seeded with no `cve_refs`, so each cited leaf
    // input carries `cveRefs: []` and the bundle aggregate is empty — the
    // empty case mirrors `aggregateTtpTags` and must not error.
    const res = await buildPeriodicReportInput({
      authPool,
      customerPool,
      customerId: CUT_CUSTOMER_ID,
      period: "DAILY",
      bucketDate: "2026-06-01",
      variant: EN,
      nowIso: "2026-06-01T20:00:00Z",
      topEventsK: 3,
    });
    expect(res.eventRefs.length).toBeGreaterThan(0);
    expect(res.aggregateCveRefs).toEqual([]);
    expect(res.aimerInputs.aggregateCveRefs).toEqual([]);
    for (const e of res.aimerInputs.eventAnalyses) {
      expect(e.cveRefs).toEqual([]);
    }
  });

  it("cites exactly the guaranteed tiers when CRITICAL/HIGH == M", async () => {
    // M=2: the two guaranteed leaves fill the ceiling, so the MEDIUM has no
    // slot and the LOW is never cited.
    expect(await citedKeys("2026-06-02", 2)).toEqual(["310", "311"]);
  });

  it("cites exactly the top-M when CRITICAL/HIGH overflow the ceiling", async () => {
    // M=2 with three CRITICAL/HIGH: only the top-2 by ranking are cited; the
    // third CRITICAL/HIGH leaf (322) and the MEDIUM (323) are dropped.
    const keys = await citedKeys("2026-06-03", 2);
    expect(keys).toEqual(["320", "321"]);
    expect(keys).not.toContain("322");
    expect(keys).not.toContain("323");
  });

  it("yields no cited events on a quiet all-LOW window (no LOW padding)", async () => {
    // Even with free slots, LOW is never cited individually.
    expect(await citedKeys("2026-06-04", 10)).toEqual([]);
  });
});
