// #493 review round 4 — pre-store eligibility re-check for the auto-baseline
// analyze path (cross-DB).
//
// The worker's claim-time check runs BEFORE the (long) LLM call, so a story
// member or a manual / default-variant `event_analysis_result` that appears
// DURING that window would otherwise be analyzed/superseded by the auto path.
// `analyzeBaselineEventLeaf` passes a `preStoreCheck` to the storage primitive
// that re-checks eligibility INSIDE the storage transaction, under the
// event-variant advisory lock, immediately before supersede+insert.
//
// These tests drive the REAL `analyzeBaselineEventLeaf` against a real customer
// DB, mocking only the aimer GraphQL call — and use that mock to commit the
// competing write (the leaf / story member) during the LLM window, exactly
// where the race lives. The redaction range/domain/decrypt helpers are stubbed
// (no auth DB / OpenBao needed); the hallucination scan stays real.

import { join } from "node:path";
import type { Pool } from "pg";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/audit", () => ({ auditLog: vi.fn() }));

const mockGraphqlRequest = vi.fn();
vi.mock("@/lib/graphql/client", () => ({
  graphqlRequest: (...args: unknown[]) => mockGraphqlRequest(...args),
}));

// Keep the real hallucination scan + range/domain primitives, but stub the
// loaders that would otherwise hit the auth DB / OpenBao.
vi.mock("@/lib/redaction", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/redaction")>();
  return {
    ...actual,
    decryptRedactionMap: vi.fn(async () => ({})),
    loadCustomerRanges: vi.fn(async () => actual.buildRangeSet([])),
    loadCustomerOwnedDomains: vi.fn(async () => actual.EMPTY_OWNED_DOMAIN_SET),
  };
});

import {
  closeAdminPool,
  createTestDatabase,
  dropTestDatabase,
  hasPostgres,
} from "@/lib/db/__tests__/db-test-helpers";
import { runMigrations } from "@/lib/db/migrate";
import { analyzeBaselineEventLeaf } from "../analyze-baseline-event";

const CUSTOMER_MIGRATIONS_DIR = join(process.cwd(), "migrations", "customer");
const CUSTOMER_LOCK_ID = 2643;
const CUSTOMER_ID = "00000000-0000-0000-0000-0000000004d2";
const AICE_ID = "aice-pre";
const LANG = "ENGLISH";
const MODEL_NAME = "openai";
const MODEL = "gpt-4o";
const BASELINE_VERSION = "bv1";
const WORKER = "system:analysis-worker";

describe.skipIf(!hasPostgres)(
  "analyzeBaselineEventLeaf pre-store re-check",
  () => {
    let customerDbName: string;
    let customerPool: Pool;
    // loadCustomerRanges / loadCustomerOwnedDomains are mocked, so the auth pool
    // is never queried — a stub satisfies the signature.
    const authPool = {} as unknown as Pool;

    beforeAll(async () => {
      const cust = await createTestDatabase("evt_prestore_cust");
      customerDbName = cust.dbName;
      customerPool = cust.pool;
      await runMigrations(
        customerPool,
        CUSTOMER_MIGRATIONS_DIR,
        CUSTOMER_LOCK_ID,
      );
    }, 60_000);

    afterAll(async () => {
      await dropTestDatabase(customerDbName, customerPool);
      await closeAdminPool();
    }, 30_000);

    beforeEach(async () => {
      vi.clearAllMocks();
      await customerPool.query("DELETE FROM event_analysis_result");
      await customerPool.query("DELETE FROM story_member");
      await customerPool.query("DELETE FROM story");
      await customerPool.query("DELETE FROM baseline_event");
      mockGraphqlRequest.mockResolvedValue({
        analyzeEvent: {
          severityScore: 0.4,
          likelihoodScore: 0.8,
          severityFactors: [],
          likelihoodFactors: [],
          ttpTags: [],
          analysis: "plain narrative with no entities",
          promptVersion: "v7",
          modelActualVersion: "gpt-4o-2026-05-01",
        },
      });
    });

    async function seedBaselineEvent(eventKey: string): Promise<void> {
      await customerPool.query(
        `INSERT INTO baseline_event
         (baseline_version, event_key, event_time, kind, raw_score,
          raw_event, score_window_context, window_signals,
          scoring_weights_snapshot, source_aice_id, received_at,
          redaction_policy_version)
       VALUES ($1, $2::numeric, '2026-05-01T00:00:00Z', 'conn', 1.0,
               $3::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, $4,
               '2026-05-01T02:00:00Z', 'engine:1.0.0|ranges:empty')`,
        [
          BASELINE_VERSION,
          eventKey,
          JSON.stringify({
            event_time: "2026-05-01T00:00:00.000Z",
            foo: "bar",
          }),
          AICE_ID,
        ],
      );
    }

    async function insertLiveLeaf(eventKey: string): Promise<void> {
      await customerPool.query(
        `INSERT INTO event_analysis_result
         (aice_id, event_key, lang, model_name, model,
          model_actual_version, prompt_version,
          severity_score, likelihood_score, priority_tier,
          analysis_text, redaction_policy_version, origin)
       VALUES ($1, $2::numeric, $3, $4, $5, 'mv', 'pv',
               0.5, 0.5, 'LOW', 'manual', 'engine:1.0.0|ranges:empty',
               'manual')`,
        [AICE_ID, eventKey, LANG, MODEL_NAME, MODEL],
      );
    }

    async function insertStoryMember(eventKey: string): Promise<void> {
      await customerPool.query(
        `INSERT INTO story
         (story_id, story_version, kind, time_window_start, time_window_end,
          summary_payload, source_aice_id, received_at)
       VALUES (9101::bigint, 'v1', 'auto_correlated',
               '2026-05-01T00:00:00Z', '2026-05-01T01:00:00Z',
               '{}'::jsonb, $1, '2026-05-01T02:00:00Z')`,
        [AICE_ID],
      );
      await customerPool.query(
        `INSERT INTO story_member
         (story_id, story_version, member_event_key, role, event,
          redaction_policy_version)
       VALUES (9101::bigint, 'v1', $1::numeric, 'primary', '{}'::jsonb,
               'engine:1.0.0')`,
        [eventKey],
      );
    }

    function liveLeafCount(eventKey: string) {
      return customerPool
        .query<{ n: string }>(
          `SELECT COUNT(*) AS n FROM event_analysis_result
          WHERE aice_id = $1 AND event_key = $2::numeric
            AND lang = $3 AND model_name = $4 AND model = $5
            AND superseded_at IS NULL`,
          [AICE_ID, eventKey, LANG, MODEL_NAME, MODEL],
        )
        .then((r) => Number(r.rows[0].n));
    }

    function autoLeafCount(eventKey: string) {
      return customerPool
        .query<{ n: string }>(
          `SELECT COUNT(*) AS n FROM event_analysis_result
          WHERE aice_id = $1 AND event_key = $2::numeric
            AND origin = 'auto_baseline'`,
          [AICE_ID, eventKey],
        )
        .then((r) => Number(r.rows[0].n));
    }

    async function analyze(eventKey: string) {
      return analyzeBaselineEventLeaf({
        authPool,
        customerPool,
        customerId: CUSTOMER_ID,
        sourceAiceId: AICE_ID,
        eventKey,
        baselineVersion: BASELINE_VERSION,
        lang: LANG,
        modelName: MODEL_NAME,
        model: MODEL,
        workerAccountId: WORKER,
      });
    }

    it("aborts (stale) when a manual leaf appears during the LLM window; never supersedes it", async () => {
      const eventKey = "5001";
      await seedBaselineEvent(eventKey);
      // The manual / default-variant leaf lands while the LLM call is in flight,
      // AFTER any claim-time check would have passed.
      mockGraphqlRequest.mockImplementationOnce(async () => {
        await insertLiveLeaf(eventKey);
        return {
          analyzeEvent: {
            severityScore: 0.4,
            likelihoodScore: 0.8,
            severityFactors: [],
            likelihoodFactors: [],
            ttpTags: [],
            analysis: "plain narrative",
            promptVersion: "v7",
            modelActualVersion: "gpt-4o-2026-05-01",
          },
        };
      });

      const out = await analyze(eventKey);
      expect(out).toEqual({ kind: "stale", reason: "live_leaf_appeared" });
      // The pre-existing manual leaf is the single live row, NOT superseded, and
      // no auto_baseline row was inserted.
      expect(await liveLeafCount(eventKey)).toBe(1);
      expect(await autoLeafCount(eventKey)).toBe(0);
    });

    it("aborts (stale) when a story member appears during the LLM window", async () => {
      const eventKey = "5002";
      await seedBaselineEvent(eventKey);
      mockGraphqlRequest.mockImplementationOnce(async () => {
        await insertStoryMember(eventKey);
        return {
          analyzeEvent: {
            severityScore: 0.4,
            likelihoodScore: 0.8,
            severityFactors: [],
            likelihoodFactors: [],
            ttpTags: [],
            analysis: "plain narrative",
            promptVersion: "v7",
            modelActualVersion: "gpt-4o-2026-05-01",
          },
        };
      });

      const out = await analyze(eventKey);
      expect(out).toEqual({ kind: "stale", reason: "story_member_appeared" });
      expect(await autoLeafCount(eventKey)).toBe(0);
    });

    it("stores normally when nothing changes during the LLM window", async () => {
      const eventKey = "5003";
      await seedBaselineEvent(eventKey);
      const out = await analyze(eventKey);
      expect(out.kind).toBe("analyzed");
      expect(await autoLeafCount(eventKey)).toBe(1);
      expect(await liveLeafCount(eventKey)).toBe(1);
    });
  },
);
