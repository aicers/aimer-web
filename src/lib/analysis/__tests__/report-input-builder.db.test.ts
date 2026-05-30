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
): Promise<void> {
  await customerPool.query(
    `INSERT INTO story_analysis_result
       (customer_id, story_id, lang, model_name, model,
        model_actual_version, prompt_version, generation,
        severity_score, likelihood_score,
        severity_factors, likelihood_factors, ttp_tags,
        priority_tier, analysis_text, input_event_refs, input_hash,
        redaction_policy_version)
     VALUES ($1, $2::bigint, $3, $4, $5,
             'mv', 'pv', 1,
             0.8, 0.7,
             '[]'::jsonb, '[]'::jsonb, '["T1078"]'::jsonb,
             $6, $7, '[]'::jsonb, 'h', 'policy-A')`,
    [
      CUSTOMER_ID,
      storyId,
      variant.lang,
      variant.modelName,
      variant.model,
      tier,
      analysis,
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
): Promise<void> {
  await customerPool.query(
    `INSERT INTO baseline_event
       (baseline_version, event_key, event_time, kind, category, raw_score,
        raw_event, score_window_context, window_signals,
        scoring_weights_snapshot, source_aice_id, received_at)
     VALUES ($1, $2::numeric, $3::timestamptz, 'k', $4, 0.5,
             '{}'::jsonb, '{}'::jsonb, '{}'::jsonb,
             '{}'::jsonb, 'aice-1', $5::timestamptz)`,
    [baselineVersion, eventKey, eventTime, category, receivedAt],
  );
}

async function seedEventResult(
  customerPool: Pool,
  eventKey: string,
  variant: { lang: string; modelName: string; model: string },
  tier: string,
  analysis: string,
): Promise<void> {
  await customerPool.query(
    `INSERT INTO event_analysis_result
       (aice_id, event_key, lang, model_name, model, generation,
        severity_score, likelihood_score,
        severity_factors, likelihood_factors, ttp_tags,
        priority_tier, analysis_text, redaction_policy_version, requested_by)
     VALUES ('aice-1', $1::numeric, $2, $3, $4, 1,
             0.6, 0.6,
             '[]'::jsonb, '[]'::jsonb, '["T1110"]'::jsonb,
             $5, $6, 'policy-A', gen_random_uuid())`,
    [eventKey, variant.lang, variant.modelName, variant.model, tier, analysis],
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
      await seedStoryResult(customerPool, "7001", EN, "HIGH", "story 7001 EN");
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

      // Event result for 6001 (EN) → eligible top event.
      await seedEventResult(
        customerPool,
        "6001",
        EN,
        "MEDIUM",
        "event 6001 EN",
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
      // Two distinct events (5001 recon, 6001 malware), each rebaselined
      // twice — total must be 2, not 4. Event 6002's canonical row is
      // out-of-window, so it must not be counted (no "exfil" bucket).
      expect(res.aimerInputs.baselineAggregates.totalCount).toBe(2);
      const dist = res.aimerInputs.baselineAggregates.categoryDistribution;
      const byCat = Object.fromEntries(dist.map((d) => [d.category, d.count]));
      expect(byCat.recon).toBe(1);
      expect(byCat.malware).toBe(1);
      expect(byCat.exfil).toBeUndefined();
      // categoryDistribution is deterministically ordered (null last, then
      // by category name) so the canonical input bundle and its order-
      // sensitive input_hash are stable across plans/runs (#297 round 4 2).
      expect(dist.map((d) => d.category)).toEqual(["malware", "recon"]);
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
  },
);
