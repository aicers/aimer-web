// Bilingual per-event analysis: translation derivation DB tests (#581).
//
// Exercises `deriveEventTranslation` against a real customer pool with the
// aimer `translateAnalysisNarrative` call mocked. Locks in:
//   - score/tier/TTP copied VERBATIM; narrative + factors translated
//   - generation aligned to the English canonical (not MAX+1)
//   - restoration_lang = ENGLISH + translation-audit trio populated; the
//     canonical's prompt_version / model_actual_version copied (not
//     overwritten by the translation response)
//   - idempotency: a second derive at the same generation is a no-op with NO
//     second aimer call
//   - canonical_missing when no English row exists
//   - leak scan + element-count mismatch fail loudly (no row written)
//   - the per-call metric + audit are emitted right after the aimer response,
//     independent of storage (so a call that later leaks is still metered)

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
import { auditLog } from "@/lib/audit";
import {
  closeAdminPool,
  createTestDatabase,
  dropTestDatabase,
  hasPostgres,
} from "@/lib/db/__tests__/db-test-helpers";
import { runMigrations } from "@/lib/db/migrate";
import { buildRangeSet, EMPTY_OWNED_DOMAIN_SET } from "@/lib/redaction";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/audit", () => ({ auditLog: vi.fn() }));

// The aimer translate call — controllable per test.
const mockGraphqlRequest = vi.fn();
vi.mock("@/lib/graphql/client", () => ({
  graphqlRequest: (...args: unknown[]) => mockGraphqlRequest(...args),
}));

const { deriveEventTranslation } = await import("../translate-event-analysis");
const {
  analyzeAndStoreEventResult,
  eventVariantLockKey,
  EVENT_GENERATION_LOCK_NAMESPACE,
} = await import("../run-analyze-flow");

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const CUSTOMER_MIGRATIONS_DIR = join(process.cwd(), "migrations", "customer");
const LOCK_ID = 3812;
const AICE = "aice-1";
const MODEL_NAME = "anthropic";
const MODEL = "claude-x";
const ACCOUNT = "00000000-0000-0000-0000-0000000000aa";

const auditBase = {
  actorId: ACCOUNT,
  authContext: "general" as const,
  targetType: "event_analysis_result",
  ipAddress: undefined,
  sid: "",
  customerId: "00000000-0000-0000-0000-000000000001",
  aiceId: AICE,
};

describe.skipIf(!hasPostgres)("deriveEventTranslation (customer DB)", () => {
  let dbName: string;
  let pool: Pool;

  async function seedCanonical(args: {
    eventKey: string;
    generation?: number;
    superseded?: boolean;
    analysis?: string;
    severityFactors?: string[];
    likelihoodFactors?: string[];
  }): Promise<void> {
    await pool.query(
      `INSERT INTO event_analysis_result
         (aice_id, event_key, lang, model_name, model,
          model_actual_version, prompt_version, generation,
          severity_score, likelihood_score,
          severity_factors, likelihood_factors, ttp_tags,
          priority_tier, analysis_text, event_time, kind,
          redaction_policy_version, requested_by, requested_at, origin,
          superseded_at)
       VALUES ($1, $2::numeric, 'ENGLISH', $3, $4,
               'mv-canon', 'pv-canon', $5,
               0.8, 0.6,
               $6::jsonb, $7::jsonb, $8::jsonb,
               'HIGH', $9, '2026-05-20T00:00:00Z', 'HttpThreat',
               'rp-v1', $10::uuid, NOW(), 'auto_baseline',
               CASE WHEN $11::boolean THEN NOW() ELSE NULL END)`,
      [
        AICE,
        args.eventKey,
        MODEL_NAME,
        MODEL,
        args.generation ?? 3,
        JSON.stringify(
          args.severityFactors ?? ["sev <<REDACTED_IP_E1_001>>", "sev two"],
        ),
        JSON.stringify(args.likelihoodFactors ?? ["lik one"]),
        JSON.stringify(["T1059", "T1071"]),
        args.analysis ?? "Narrative with <<REDACTED_IP_E1_001>>.",
        ACCOUNT,
        args.superseded ?? false,
      ],
    );
  }

  function happyTranslation() {
    return {
      translateAnalysisNarrative: {
        analysis: "KO narrative <<REDACTED_IP_E1_001>>.",
        severityFactors: ["ko sev <<REDACTED_IP_E1_001>>", "ko sev two"],
        likelihoodFactors: ["ko lik one"],
        promptVersion: "tp-v9",
        modelActualVersion: "tmv-9",
      },
    };
  }

  async function liveKoreanRow(eventKey: string) {
    const { rows } = await pool.query(
      `SELECT lang, restoration_lang, severity_score, likelihood_score,
              priority_tier, ttp_tags, severity_factors, likelihood_factors,
              analysis_text, generation, model_name, model,
              model_actual_version, prompt_version,
              translation_model_name, translation_model,
              translation_prompt_version, kind, origin, requested_by
         FROM event_analysis_result
        WHERE aice_id = $1 AND event_key = $2::numeric AND lang = 'KOREAN'
          AND superseded_at IS NULL`,
      [AICE, eventKey],
    );
    return rows[0];
  }

  // Poll until the translation write is parked (granted = false) on the English
  // variant advisory lock. `pg_advisory_xact_lock($1, $2)` records classid = the
  // namespace, objid = the (unsigned) variant key, objsubid = 2.
  async function waitForBlockedEnglishLock(key: number): Promise<void> {
    const objid = key >>> 0;
    for (let i = 0; i < 200; i += 1) {
      const { rows } = await pool.query(
        `SELECT 1 FROM pg_locks
          WHERE locktype = 'advisory' AND classid = $1
            AND objid = $2 AND objsubid = 2 AND NOT granted
          LIMIT 1`,
        [EVENT_GENERATION_LOCK_NAMESPACE, objid],
      );
      if (rows.length > 0) return;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error(
      "timed out waiting for the translation to block on the lock",
    );
  }

  function derive(eventKey: string) {
    return deriveEventTranslation({
      customerPool: pool,
      aiceId: AICE,
      eventKey,
      modelName: MODEL_NAME,
      model: MODEL,
      targetLang: "KOREAN",
      accountId: ACCOUNT,
      graphqlAiceId: AICE,
      requestedBy: null,
      auditBase,
    });
  }

  beforeAll(async () => {
    const cust = await createTestDatabase("event_translate");
    dbName = cust.dbName;
    pool = cust.pool;
    await runMigrations(pool, CUSTOMER_MIGRATIONS_DIR, LOCK_ID);
  });

  afterAll(async () => {
    await dropTestDatabase(dbName, pool);
    await closeAdminPool();
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    mockGraphqlRequest.mockResolvedValue(happyTranslation());
    await pool.query("DELETE FROM event_analysis_result");
  });

  it("copies scores/tier/TTP verbatim and translates narrative + factors", async () => {
    await seedCanonical({ eventKey: "100" });
    const res = await derive("100");
    expect(res).toEqual({ kind: "translated", generation: 3 });

    const row = await liveKoreanRow("100");
    expect(row.lang).toBe("KOREAN");
    expect(row.restoration_lang).toBe("ENGLISH");
    // Numeric scores / tier / TTP copied verbatim.
    expect(row.severity_score).toBe(0.8);
    expect(row.likelihood_score).toBe(0.6);
    expect(row.priority_tier).toBe("HIGH");
    expect(row.ttp_tags).toEqual(["T1059", "T1071"]);
    // Narrative + factors translated.
    expect(row.analysis_text).toBe("KO narrative <<REDACTED_IP_E1_001>>.");
    expect(row.severity_factors).toEqual([
      "ko sev <<REDACTED_IP_E1_001>>",
      "ko sev two",
    ]);
    expect(row.likelihood_factors).toEqual(["ko lik one"]);
    // Generation aligned to canonical; key fields shared with canonical.
    expect(row.generation).toBe(3);
    expect(row.model_name).toBe(MODEL_NAME);
    expect(row.model).toBe(MODEL);
    expect(row.kind).toBe("HttpThreat");
    expect(row.origin).toBe("auto_baseline");
    // Canonical provenance copied (NOT overwritten by the translation).
    expect(row.prompt_version).toBe("pv-canon");
    expect(row.model_actual_version).toBe("mv-canon");
    // Translation audit trio: configured selector + response promptVersion.
    expect(row.translation_model_name).toBe(MODEL_NAME);
    expect(row.translation_model).toBe(MODEL);
    expect(row.translation_prompt_version).toBe("tp-v9");
  });

  it("is idempotent at the canonical generation — no duplicate, no second call", async () => {
    await seedCanonical({ eventKey: "101" });
    const first = await derive("101");
    expect(first.kind).toBe("translated");
    expect(mockGraphqlRequest).toHaveBeenCalledTimes(1);

    const second = await derive("101");
    expect(second).toEqual({ kind: "noop", generation: 3 });
    // No second aimer call.
    expect(mockGraphqlRequest).toHaveBeenCalledTimes(1);

    // Exactly one materialized KOREAN row for the event under test — the second
    // derive neither duplicated nor left a stale row at the canonical generation.
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM event_analysis_result
        WHERE aice_id = $1 AND event_key = '101'::numeric AND lang = 'KOREAN'`,
      [AICE],
    );
    expect(rows[0].n).toBe(1);
  });

  it("supersedes a prior translated row when the canonical regenerates", async () => {
    // Old canonical + its translation at gen 3, both superseded.
    await seedCanonical({ eventKey: "103", generation: 3, superseded: true });
    await derive("103"); // would write at gen 3...
    // Now supersede the gen-3 canonical and add a fresh gen-4 canonical.
    await pool.query(
      `UPDATE event_analysis_result SET superseded_at = NOW()
        WHERE aice_id = $1 AND event_key = '103'::numeric AND generation = 3`,
      [AICE],
    );
    await seedCanonical({ eventKey: "103", generation: 4 });

    const res = await derive("103");
    expect(res).toEqual({ kind: "translated", generation: 4 });

    const live = await liveKoreanRow("103");
    expect(live.generation).toBe(4);
    // Only one live KOREAN row.
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM event_analysis_result
        WHERE aice_id = $1 AND event_key = '103'::numeric AND lang = 'KOREAN'
          AND superseded_at IS NULL`,
      [AICE],
    );
    expect(rows[0].n).toBe(1);
  });

  it("retires a stale user-language translation when the canonical advances even if the re-translation never runs", async () => {
    // #581 review R3: a canonical regeneration followed by a FAILED
    // re-translation must not leave the old user-language row live at the
    // superseded generation. `deriveEventTranslation` only supersedes the prior
    // translation INSIDE a successful write, so if it errors/leaks the stale
    // row would otherwise stay `superseded_at IS NULL`. The event detail loader
    // hides that behind its generation-first fallback, but the report input
    // builder selects live leaves per report language
    // (`WHERE lang = $1 AND superseded_at IS NULL`, newest generation within
    // that language), so a Korean report could cite the stale gen-3 leaf while
    // English advanced to gen 4. The canonical-advance write must therefore
    // retire ALL languages at the superseded generation, so the failed
    // re-translation falls back to English (no live Korean leaf), never a stale
    // one.
    await seedCanonical({ eventKey: "106", generation: 3 });
    await derive("106"); // English + Korean both live at gen 3.

    // Regenerate the English canonical to gen 4. The follow-up re-translation is
    // NOT invoked here (simulating a translation failure / deferred retry), so
    // only the canonical-advance supersede can retire the Korean gen-3 row.
    mockGraphqlRequest.mockResolvedValueOnce({
      analyzeEvent: {
        severityScore: 0.8,
        likelihoodScore: 0.6,
        severityFactors: ["sev <<REDACTED_IP_E1_001>>", "sev two"],
        likelihoodFactors: ["lik one"],
        ttpTags: ["T1059", "T1071"],
        analysis: "Narrative with <<REDACTED_IP_E1_001>>.",
        promptVersion: "pv-canon-2",
        modelActualVersion: "mv-canon-2",
      },
    });
    const stored = await analyzeAndStoreEventResult({
      customerPool: pool,
      aiceId: AICE,
      eventKey: "106",
      redactedEvent: { event_time: "2026-05-20T00:00:00Z" },
      eventTimeForAimer: "2026-05-20T00:00:00Z",
      eventKind: null,
      lang: "ENGLISH",
      langForStorage: "ENGLISH",
      modelName: MODEL_NAME,
      model: MODEL,
      accountId: ACCOUNT,
      mergedMap: {},
      ranges: buildRangeSet([]),
      ownedDomains: EMPTY_OWNED_DOMAIN_SET,
      redactionPolicyVersion: "rp-v1",
      origin: "manual",
      requestedBy: ACCOUNT,
      auditBase,
      force: true,
    });
    expect(stored).toEqual({ kind: "success", generation: 4 });

    // The English canonical advanced to gen 4...
    const liveEnglish = await pool.query<{ generation: number }>(
      `SELECT generation FROM event_analysis_result
        WHERE aice_id = $1 AND event_key = '106'::numeric AND lang = 'ENGLISH'
          AND superseded_at IS NULL`,
      [AICE],
    );
    expect(liveEnglish.rows.map((r) => r.generation)).toEqual([4]);

    // ...and the stale Korean gen-3 translation is no longer a live leaf: the
    // report input builder selects none for KOREAN, so the report falls back to
    // English rather than citing the superseded translation.
    const liveKorean = await pool.query(
      `SELECT generation FROM event_analysis_result
        WHERE aice_id = $1 AND event_key = '106'::numeric AND lang = 'KOREAN'
          AND superseded_at IS NULL`,
      [AICE],
    );
    expect(liveKorean.rows).toHaveLength(0);
  });

  it("abandons a stale translation as a no-op when the canonical advances mid-call", async () => {
    // Simulate a concurrent English regeneration: the canonical is read at
    // gen 3 before the aimer call, but advances to gen 4 (gen 3 superseded)
    // WHILE the translate call is in flight. The under-lock re-validation must
    // then abandon the now-stale gen-3 translation as a no-op rather than write
    // a stale live KOREAN row at gen 3 (#581 review R1).
    await seedCanonical({ eventKey: "104", generation: 3 });
    mockGraphqlRequest.mockImplementation(async () => {
      await pool.query(
        `UPDATE event_analysis_result SET superseded_at = NOW()
          WHERE aice_id = $1 AND event_key = '104'::numeric AND generation = 3`,
        [AICE],
      );
      await seedCanonical({ eventKey: "104", generation: 4 });
      return happyTranslation();
    });

    const res = await derive("104");
    // The latest live canonical is gen 4; the gen-3 translation is abandoned.
    expect(res).toEqual({ kind: "noop", generation: 4 });
    // No KOREAN row was written at all (the stale gen-3 insert was skipped).
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM event_analysis_result
        WHERE aice_id = $1 AND event_key = '104'::numeric AND lang = 'KOREAN'`,
      [AICE],
    );
    expect(rows[0].n).toBe(0);
  });

  it("serializes the write against an English regeneration holding the canonical lock", async () => {
    // The Round-1 fix re-reads the live canonical under the write lock, but that
    // re-check is only sound if it is mutually exclusive with English canonical
    // advancement. The canonical write serializes on the ENGLISH variant lock —
    // a different key from the target language — so the translation write must
    // take that same English lock before its re-check (#581 review R2).
    //
    // Here a concurrent English regeneration holds the English variant lock and
    // has staged gen 4 (gen 3 superseded) but has NOT committed. The translation
    // reads gen 3 (the only committed live canonical), translates, then must
    // BLOCK acquiring the English lock until the regeneration commits — and then
    // observe gen 4, abandoning the now-stale gen-3 translation. Without the
    // English lock it would slip into the window between re-check and insert and
    // write a stale live gen-3 KOREAN row.
    await seedCanonical({ eventKey: "105", generation: 3 });
    const englishLockKey = eventVariantLockKey(
      AICE,
      "105",
      "ENGLISH",
      MODEL_NAME,
      MODEL,
    );

    const reachedTranslate = deferred();
    const proceed = deferred();
    mockGraphqlRequest.mockImplementation(async () => {
      reachedTranslate.resolve();
      await proceed.promise;
      return happyTranslation();
    });

    const blocker = await pool.connect();
    try {
      // Regeneration: hold the English variant lock and stage gen 4 uncommitted.
      await blocker.query("BEGIN");
      await blocker.query("SELECT pg_advisory_xact_lock($1, $2)", [
        EVENT_GENERATION_LOCK_NAMESPACE,
        englishLockKey,
      ]);
      await blocker.query(
        `UPDATE event_analysis_result SET superseded_at = NOW()
          WHERE aice_id = $1 AND event_key = '105'::numeric AND generation = 3`,
        [AICE],
      );
      await blocker.query(
        `INSERT INTO event_analysis_result
           (aice_id, event_key, lang, model_name, model,
            model_actual_version, prompt_version, generation,
            severity_score, likelihood_score,
            severity_factors, likelihood_factors, ttp_tags,
            priority_tier, analysis_text, event_time, kind,
            redaction_policy_version, requested_by, requested_at, origin)
         VALUES ($1, '105'::numeric, 'ENGLISH', $2, $3,
                 'mv-canon', 'pv-canon', 4,
                 0.8, 0.6,
                 $4::jsonb, $5::jsonb, $6::jsonb,
                 'HIGH', $7, '2026-05-20T00:00:00Z', 'HttpThreat',
                 'rp-v1', $8::uuid, NOW(), 'auto_baseline')`,
        [
          AICE,
          MODEL_NAME,
          MODEL,
          JSON.stringify(["sev <<REDACTED_IP_E1_001>>", "sev two"]),
          JSON.stringify(["lik one"]),
          JSON.stringify(["T1059", "T1071"]),
          "Narrative with <<REDACTED_IP_E1_001>>.",
          ACCOUNT,
        ],
      );

      // Start the translation; it reads gen 3, translates, then parks on the
      // English lock the regeneration holds.
      const derivePromise = derive("105");
      await reachedTranslate.promise;
      proceed.resolve();
      await waitForBlockedEnglishLock(englishLockKey);

      // Commit the regeneration: release the lock and make gen 4 live.
      await blocker.query("COMMIT");

      const res = await derivePromise;
      expect(res).toEqual({ kind: "noop", generation: 4 });
    } finally {
      blocker.release();
    }

    // No stale gen-3 KOREAN row was written.
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM event_analysis_result
        WHERE aice_id = $1 AND event_key = '105'::numeric AND lang = 'KOREAN'`,
      [AICE],
    );
    expect(rows[0].n).toBe(0);
  });

  it("returns canonical_missing when no English canonical exists", async () => {
    const res = await derive("200");
    expect(res).toEqual({ kind: "canonical_missing" });
    expect(mockGraphqlRequest).not.toHaveBeenCalled();
  });

  it("fails loudly on a redaction-token leak, writing no row", async () => {
    await seedCanonical({ eventKey: "300" });
    // Translation drops the token from the narrative.
    mockGraphqlRequest.mockResolvedValue({
      translateAnalysisNarrative: {
        analysis: "KO narrative without the token.",
        severityFactors: ["ko sev <<REDACTED_IP_E1_001>>", "ko sev two"],
        likelihoodFactors: ["ko lik one"],
        promptVersion: "tp-v9",
        modelActualVersion: "tmv-9",
      },
    });
    const res = await derive("300");
    expect(res.kind).toBe("leak");
    expect(await liveKoreanRow("300")).toBeUndefined();
  });

  it("meters the call (per-call metric + audit) after the response, even when the result later leaks (no row)", async () => {
    await seedCanonical({ eventKey: "302" });
    // Translation drops a token, so the leak scan rejects it and NO row is
    // written. The aimer call was still spent, so the per-call metric + audit
    // MUST have been emitted from the post-response point — independent of
    // storage (#581 per-call cost metering).
    mockGraphqlRequest.mockResolvedValue({
      translateAnalysisNarrative: {
        analysis: "KO narrative without the token.",
        severityFactors: ["ko sev <<REDACTED_IP_E1_001>>", "ko sev two"],
        likelihoodFactors: ["ko lik one"],
        promptVersion: "tp-v9",
        modelActualVersion: "tmv-9",
      },
    });
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      const res = await derive("302");
      expect(res.kind).toBe("leak");
      expect(await liveKoreanRow("302")).toBeUndefined();

      // Per-call metric carries the response provenance.
      const callMetric = infoSpy.mock.calls
        .map((c) => String(c[0]))
        .find((line) => line.includes('"analysis.event_translation.call"'));
      expect(callMetric).toBeDefined();
      expect(callMetric).toContain('"translation_prompt_version":"tp-v9"');
      expect(callMetric).toContain(
        '"translation_model_actual_version":"tmv-9"',
      );
    } finally {
      infoSpy.mockRestore();
    }

    // The call-level audit recorded the same response metadata...
    const auditActions = vi.mocked(auditLog).mock.calls.map((c) => c[0]);
    const callAudit = auditActions.find(
      (a) => a.action === "ai_analysis.aimer_call_succeeded",
    );
    expect(callAudit).toBeDefined();
    expect(callAudit?.details).toMatchObject({
      translate: true,
      lang: "KOREAN",
      translation_prompt_version: "tp-v9",
      translation_model_actual_version: "tmv-9",
    });
    // ...while the storage-confirmation audit/metric did NOT fire (no row).
    expect(
      auditActions.find((a) => a.action === "ai_analysis.result_stored"),
    ).toBeUndefined();
  });

  it("fails loudly on a factor element-count mismatch, writing no row", async () => {
    await seedCanonical({ eventKey: "301" });
    mockGraphqlRequest.mockResolvedValue({
      translateAnalysisNarrative: {
        analysis: "KO narrative <<REDACTED_IP_E1_001>>.",
        // canonical has 2 severity factors; return 1.
        severityFactors: ["ko sev only"],
        likelihoodFactors: ["ko lik one"],
        promptVersion: "tp-v9",
        modelActualVersion: "tmv-9",
      },
    });
    const res = await derive("301");
    expect(res).toMatchObject({ kind: "leak", field: "factor_count" });
    expect(await liveKoreanRow("301")).toBeUndefined();
  });
});
