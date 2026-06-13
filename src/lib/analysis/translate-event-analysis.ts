// Bilingual per-event analysis: derive the user-language row from the
// English canonical (#581).
//
// "English is canonical, the user-language row is a translation" — the same
// model periodic reports use (`report-worker.ts` `runTranslation`). The
// English `event_analysis_result` row is generated natively; the
// user-language row is ALWAYS produced by translating the canonical's
// narrative + score-factor phrases via aimer's `translateAnalysisNarrative`
// mutation (aicers/aimer#495), while the numeric scores, priority tier, and
// TTP codes are copied from the canonical VERBATIM so they never diverge
// across languages.
//
// This module is the single derivation primitive shared by every
// non-English entry point: the auto-baseline worker, the manual/synchronous
// analyze path, and synchronous regenerate. None of them ever natively
// generates a non-English row.
//
// SERVER-ONLY. Reads/writes the customer DB (`event_analysis_result`) and
// calls aimer.

import "server-only";

import type { Pool } from "pg";
import { auditLog } from "@/lib/audit";
import { TranslateEventDocument } from "@/lib/graphql/__generated__/translate-event";
import { graphqlRequest } from "@/lib/graphql/client";
import type { AnalyzeErrorCode } from "./analyze-types";
import {
  type AuditEmissionBase,
  DEFAULT_LANG,
  EVENT_GENERATION_LOCK_NAMESPACE,
  eventVariantLockKey,
  mapAimerError,
  type SupportedLang,
} from "./run-analyze-flow";

// The translation model is independent of the generation model (aimer#495
// `name` + `model` arguments). It defaults to the SAME model that produced
// the canonical — so a translation rides the customer's resolved default —
// and can be overridden globally for cost/quality tuning, mirroring the
// report worker's `ANALYSIS_TRANSLATION_MODEL{,_NAME}` knobs.
const TRANSLATION_MODEL_NAME_OVERRIDE =
  process.env.ANALYSIS_TRANSLATION_MODEL_NAME;
const TRANSLATION_MODEL_OVERRIDE = process.env.ANALYSIS_TRANSLATION_MODEL;

// Broad, opaque redaction-token matcher (#495): event-scope tokens are owned
// by aimer-web and carry no fixed category/ordinal shape, so match anything
// of the form `<<REDACTED_…>>` rather than the report-scope `R`-token regex.
const REDACTION_TOKEN_RE = /<<REDACTED_[^<>\r\n]+>>/g;

function emitMetric(event: string, fields: Record<string, unknown>): void {
  console.info(
    JSON.stringify({
      level: "info",
      event: `analysis.event_translation.${event}`,
      ...fields,
    }),
  );
}

/**
 * The English canonical row a translation is derived from. The numeric
 * scores, tier, and TTP codes are copied to the translated row verbatim; the
 * narrative + factor phrases are sent to aimer for translation; the
 * provenance (`prompt_version` / `model_actual_version` / `generation` /
 * `kind` / `event_time` / `redaction_policy_version` / `origin`) is copied so
 * the translated row mirrors exactly the canonical generation it expresses.
 */
interface CanonicalRow {
  generation: number;
  severityScore: number;
  likelihoodScore: number;
  severityFactors: string[];
  likelihoodFactors: string[];
  ttpTags: string[];
  priorityTier: string;
  analysisText: string;
  eventTime: Date;
  kind: string | null;
  redactionPolicyVersion: string;
  modelActualVersion: string;
  promptVersion: string;
  origin: string;
}

export interface DeriveEventTranslationParams {
  customerPool: Pool;
  aiceId: string;
  eventKey: string;
  /** Analysis variant key shared with the canonical (only `lang` differs). */
  modelName: string;
  model: string;
  /** Destination language; MUST differ from the English canonical. */
  targetLang: SupportedLang;
  /** Account threaded into aimer's request context for the translate call. */
  accountId: string;
  /** AICE id threaded into aimer's request context. */
  graphqlAiceId: string;
  /** Value written to the translated row's `requested_by` (NULL for auto). */
  requestedBy: string | null;
  auditBase: AuditEmissionBase;
}

export type DeriveEventTranslationResult =
  // A fresh translated row was written at the canonical's generation.
  | { kind: "translated"; generation: number }
  // Finalize/no-op — no duplicate row and (on the pre-call path) no second
  // aimer call. Covers two cases: a live translated row already existed at the
  // canonical's generation, OR the canonical advanced past the generation this
  // call translated (a concurrent regeneration committed a newer canonical, so
  // this now-stale translation is abandoned rather than written). `generation`
  // is the latest live canonical generation the caller should treat as current.
  | { kind: "noop"; generation: number }
  // No live English canonical yet — the caller defers (it cannot translate
  // what does not exist).
  | { kind: "canonical_missing" }
  // Translation output failed a leak / shape check — TERMINAL, fail loudly.
  | { kind: "leak"; field: string; message: string }
  // aimer call / storage failure — retryable.
  | { kind: "error"; errorCode: AnalyzeErrorCode; message: string };

async function readLiveCanonical(
  customerPool: Pool,
  aiceId: string,
  eventKey: string,
  modelName: string,
  model: string,
): Promise<CanonicalRow | null> {
  const { rows } = await customerPool.query<{
    generation: number;
    severity_score: number;
    likelihood_score: number;
    severity_factors: string[];
    likelihood_factors: string[];
    ttp_tags: string[];
    priority_tier: string;
    analysis_text: string;
    event_time: Date;
    kind: string | null;
    redaction_policy_version: string;
    model_actual_version: string;
    prompt_version: string;
    origin: string;
  }>(
    `SELECT generation, severity_score, likelihood_score,
            severity_factors, likelihood_factors, ttp_tags,
            priority_tier, analysis_text, event_time, kind,
            redaction_policy_version, model_actual_version, prompt_version,
            origin
       FROM event_analysis_result
      WHERE aice_id = $1 AND event_key = $2::numeric
        AND lang = $3 AND model_name = $4 AND model = $5
        AND superseded_at IS NULL
      ORDER BY generation DESC
      LIMIT 1`,
    [aiceId, eventKey, DEFAULT_LANG, modelName, model],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    generation: row.generation,
    severityScore: row.severity_score,
    likelihoodScore: row.likelihood_score,
    severityFactors: row.severity_factors,
    likelihoodFactors: row.likelihood_factors,
    ttpTags: row.ttp_tags,
    priorityTier: row.priority_tier,
    analysisText: row.analysis_text,
    eventTime: row.event_time,
    kind: row.kind,
    redactionPolicyVersion: row.redaction_policy_version,
    modelActualVersion: row.model_actual_version,
    promptVersion: row.prompt_version,
    origin: row.origin,
  };
}

/** Whether a translated row already exists at the given generation (any
 * supersede state — the PK slot being occupied means the translation for
 * that generation is materialized). */
async function translationExistsAtGeneration(
  customerPool: Pool,
  aiceId: string,
  eventKey: string,
  targetLang: SupportedLang,
  modelName: string,
  model: string,
  generation: number,
): Promise<boolean> {
  const { rows } = await customerPool.query<{ one: number }>(
    `SELECT 1 AS one
       FROM event_analysis_result
      WHERE aice_id = $1 AND event_key = $2::numeric
        AND lang = $3 AND model_name = $4 AND model = $5
        AND generation = $6
      LIMIT 1`,
    [aiceId, eventKey, targetLang, modelName, model, generation],
  );
  return rows.length > 0;
}

function tokenMultiset(text: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const match of text.matchAll(REDACTION_TOKEN_RE)) {
    counts.set(match[0], (counts.get(match[0]) ?? 0) + 1);
  }
  return counts;
}

function multisetsEqual(
  a: Map<string, number>,
  b: Map<string, number>,
): boolean {
  if (a.size !== b.size) return false;
  for (const [token, n] of a) {
    if (b.get(token) !== n) return false;
  }
  return true;
}

/**
 * Stricter than the native hallucination scan: verify the translated text
 * preserves the canonical's redaction tokens EXACTLY, per field and per
 * factor-array index (so a token added, dropped, or moved between the
 * narrative and a factor — or between factor indices — is rejected). The
 * caller must already have confirmed the factor arrays are the same length.
 * Returns the offending field on failure.
 */
function scanTranslationLeak(
  canonical: { analysis: string; severity: string[]; likelihood: string[] },
  translated: { analysis: string; severity: string[]; likelihood: string[] },
): { ok: true } | { ok: false; field: string } {
  if (
    !multisetsEqual(
      tokenMultiset(canonical.analysis),
      tokenMultiset(translated.analysis),
    )
  ) {
    return { ok: false, field: "analysis" };
  }
  for (let i = 0; i < canonical.severity.length; i += 1) {
    if (
      !multisetsEqual(
        tokenMultiset(canonical.severity[i]),
        tokenMultiset(translated.severity[i]),
      )
    ) {
      return { ok: false, field: `severity_factors[${i}]` };
    }
  }
  for (let i = 0; i < canonical.likelihood.length; i += 1) {
    if (
      !multisetsEqual(
        tokenMultiset(canonical.likelihood[i]),
        tokenMultiset(translated.likelihood[i]),
      )
    ) {
      return { ok: false, field: `likelihood_factors[${i}]` };
    }
  }
  return { ok: true };
}

/**
 * Derive (or finalize) the user-language `event_analysis_result` row for an
 * event whose English canonical already exists, by translating the
 * canonical's narrative + factor phrases via aimer#495 and copying its
 * numeric scores / tier / TTP / provenance / generation verbatim.
 *
 * Idempotent: a live translated row at the canonical's generation is a
 * no-op (no duplicate, no second aimer call); a fresh translation supersedes
 * any prior live translated row exactly as the native generation path does.
 * Single-row safety under crash/retry and sync-vs-worker races is enforced by
 * the result PK + `ON CONFLICT DO NOTHING`; the pre-call existence check
 * skips the (expensive) aimer call on the common retry path. The canonical
 * generation is also re-validated while holding BOTH the English canonical
 * variant lock and the target-language variant lock (so the re-check is
 * mutually exclusive with English canonical advancement): if a concurrent
 * regeneration advanced the canonical while this call was translating, the
 * now-stale translation is abandoned as a no-op rather than written, so no
 * translated row is ever pinned to a superseded canonical generation.
 */
export async function deriveEventTranslation(
  params: DeriveEventTranslationParams,
): Promise<DeriveEventTranslationResult> {
  const {
    customerPool,
    aiceId,
    eventKey,
    modelName,
    model,
    targetLang,
    auditBase,
  } = params;
  const targetId = `${aiceId}/${eventKey}`;

  // 1. The canonical must exist; if it does and the translation for its
  //    generation is already materialized, finalize without a second call.
  const canonical = await readLiveCanonical(
    customerPool,
    aiceId,
    eventKey,
    modelName,
    model,
  );
  if (!canonical) return { kind: "canonical_missing" };
  if (
    await translationExistsAtGeneration(
      customerPool,
      aiceId,
      eventKey,
      targetLang,
      modelName,
      model,
      canonical.generation,
    )
  ) {
    return { kind: "noop", generation: canonical.generation };
  }

  const translationModelName = TRANSLATION_MODEL_NAME_OVERRIDE ?? modelName;
  const translationModel = TRANSLATION_MODEL_OVERRIDE ?? model;

  void auditLog({
    ...auditBase,
    action: "ai_analysis.request_issued",
    targetId,
    details: {
      lang: targetLang,
      modelName,
      model,
      translate: true,
      restoration_lang: DEFAULT_LANG,
      translation_model_name: translationModelName,
      translation_model: translationModel,
      generation: canonical.generation,
    },
  });

  // 2. Translate the narrative + factor phrases (numeric scores / tier / TTP
  //    are NOT sent — they are copied from the canonical).
  let resp: {
    analysis: string;
    severityFactors: string[];
    likelihoodFactors: string[];
    promptVersion: string;
    modelActualVersion: string;
  };
  try {
    const r = await graphqlRequest(
      TranslateEventDocument,
      {
        analysis: canonical.analysisText,
        severityFactors: canonical.severityFactors,
        likelihoodFactors: canonical.likelihoodFactors,
        targetLang,
        name: translationModelName,
        model: translationModel,
      },
      { accountId: params.accountId, aiceId: params.graphqlAiceId },
    );
    resp = r.translateAnalysisNarrative;
  } catch (err) {
    const code = mapAimerError(err);
    void auditLog({
      ...auditBase,
      action: "ai_analysis.aimer_call_failed",
      targetId,
      details: {
        stage: "translate_call",
        translate: true,
        lang: targetLang,
        code,
        error: err instanceof Error ? err.message : String(err),
      },
    });
    return {
      kind: "error",
      errorCode: code,
      message: err instanceof Error ? err.message : "translate call failed",
    };
  }

  // 3. Defensive checks. aimer#495 already guarantees one-per-input-in-order
  //    factors and verbatim token preservation, but a leak/shape failure must
  //    FAIL the job loudly here — never substitute, never re-shape — before
  //    any row is written. Do NOT re-run the factor shape-filter: the arrays
  //    are an element-wise translation of the canonical's already-filtered
  //    factors, so a length/order change would silently break the
  //    factor↔meaning correspondence even though the numbers match.
  if (
    resp.severityFactors.length !== canonical.severityFactors.length ||
    resp.likelihoodFactors.length !== canonical.likelihoodFactors.length
  ) {
    const message =
      `factor count changed in translation: severity ` +
      `${canonical.severityFactors.length}->${resp.severityFactors.length}, ` +
      `likelihood ${canonical.likelihoodFactors.length}->` +
      `${resp.likelihoodFactors.length}`;
    void auditLog({
      ...auditBase,
      action: "ai_analysis.hallucination_detected",
      targetId,
      details: { translate: true, lang: targetLang, failure: "factor_count" },
    });
    return { kind: "leak", field: "factor_count", message };
  }
  const leak = scanTranslationLeak(
    {
      analysis: canonical.analysisText,
      severity: canonical.severityFactors,
      likelihood: canonical.likelihoodFactors,
    },
    {
      analysis: resp.analysis,
      severity: resp.severityFactors,
      likelihood: resp.likelihoodFactors,
    },
  );
  if (!leak.ok) {
    void auditLog({
      ...auditBase,
      action: "ai_analysis.hallucination_detected",
      targetId,
      details: { translate: true, lang: targetLang, failure: leak.field },
    });
    return {
      kind: "leak",
      field: leak.field,
      message: `redaction-token leak in translated ${leak.field}`,
    };
  }

  // 4. Supersede any prior live translated row and INSERT the fresh
  //    translation AT THE CANONICAL'S GENERATION (never MAX+1) under the
  //    per-variant advisory lock, so the two language rows of one analysis
  //    share a generation. `ON CONFLICT DO NOTHING` makes a lost race a
  //    no-op rather than a duplicate.
  let inserted: boolean;
  try {
    const writeClient = await customerPool.connect();
    try {
      await writeClient.query("BEGIN");
      // Acquire BOTH the English canonical variant lock and the target-language
      // variant lock, English FIRST. The canonical re-check below is only sound
      // if it is mutually exclusive with English canonical advancement, and the
      // canonical write (`run-analyze-flow.ts`) serializes its supersede+insert
      // on the ENGLISH variant lock — a DIFFERENT key from this call's target
      // lang. Holding only the target lock would let an English regeneration
      // commit generation N+1 between this re-check and the insert below,
      // leaving a stale live translated row at N beside the N+1 canonical.
      // Taking the English lock here closes that window. The target lock still
      // serializes concurrent translations of the same target variant
      // (idempotent supersede+insert). Lock order is fixed (English then
      // target) and the canonical write only ever holds the single English
      // lock — released on its COMMIT before this call runs — so no lock cycle
      // (hence no deadlock) is possible.
      await writeClient.query("SELECT pg_advisory_xact_lock($1, $2)", [
        EVENT_GENERATION_LOCK_NAMESPACE,
        eventVariantLockKey(aiceId, eventKey, DEFAULT_LANG, modelName, model),
      ]);
      await writeClient.query("SELECT pg_advisory_xact_lock($1, $2)", [
        EVENT_GENERATION_LOCK_NAMESPACE,
        eventVariantLockKey(aiceId, eventKey, targetLang, modelName, model),
      ]);
      // Re-validate the canonical generation under the locks. The canonical was
      // read (and the aimer translate call issued) BEFORE these locks, so a
      // concurrent English regeneration may have committed a newer canonical
      // (generation N+1) while this call was translating generation N's text.
      // Now that the English variant lock is held, any such regeneration has
      // either already committed (and is visible to this SELECT) or is blocked
      // behind us until we COMMIT. Writing a row for a superseded generation
      // would leave a stale live translated row at N alongside the N+1
      // derivation. If the canonical advanced, abandon this stale translation as
      // a no-op — the regenerate path re-derives the user language synchronously
      // at N+1 (#581), so the newer derivation owns the live row. If nothing is
      // live, the canonical was fully superseded with no replacement yet; let
      // the caller defer.
      const live = await writeClient.query<{ generation: number }>(
        `SELECT generation FROM event_analysis_result
          WHERE aice_id = $1 AND event_key = $2::numeric
            AND lang = $3 AND model_name = $4 AND model = $5
            AND superseded_at IS NULL
          ORDER BY generation DESC
          LIMIT 1`,
        [aiceId, eventKey, DEFAULT_LANG, modelName, model],
      );
      const liveCanonicalGeneration = live.rows[0]?.generation ?? null;
      if (liveCanonicalGeneration === null) {
        await writeClient.query("ROLLBACK");
        return { kind: "canonical_missing" };
      }
      if (liveCanonicalGeneration !== canonical.generation) {
        await writeClient.query("ROLLBACK");
        return { kind: "noop", generation: liveCanonicalGeneration };
      }
      await writeClient.query(
        `UPDATE event_analysis_result
            SET superseded_at = NOW()
          WHERE aice_id = $1 AND event_key = $2::numeric
            AND lang = $3 AND model_name = $4 AND model = $5
            AND generation < $6
            AND superseded_at IS NULL`,
        [aiceId, eventKey, targetLang, modelName, model, canonical.generation],
      );
      const ins = await writeClient.query(
        `INSERT INTO event_analysis_result
           (aice_id, event_key, lang, restoration_lang, model_name, model,
            model_actual_version, prompt_version, generation,
            severity_score, likelihood_score,
            severity_factors, likelihood_factors, ttp_tags,
            priority_tier,
            analysis_text, event_time, kind,
            redaction_policy_version, requested_by,
            origin,
            translation_model_name, translation_model,
            translation_prompt_version)
         VALUES ($1, $2::numeric, $3, $4, $5, $6,
                 $7, $8, $9,
                 $10, $11,
                 $12::jsonb, $13::jsonb, $14::jsonb,
                 $15,
                 $16, $17::timestamptz, $18,
                 $19, $20::uuid,
                 $21,
                 $22, $23,
                 $24)
         ON CONFLICT
           (aice_id, event_key, lang, model_name, model, generation)
         DO NOTHING`,
        [
          aiceId,
          eventKey,
          targetLang,
          DEFAULT_LANG, // restoration_lang — replay canonical tokens as English
          modelName,
          model,
          canonical.modelActualVersion, // copied verbatim from canonical
          canonical.promptVersion, // copied verbatim from canonical
          canonical.generation, // SAME generation as the canonical
          canonical.severityScore,
          canonical.likelihoodScore,
          JSON.stringify(resp.severityFactors),
          JSON.stringify(resp.likelihoodFactors),
          JSON.stringify(canonical.ttpTags),
          canonical.priorityTier,
          resp.analysis,
          canonical.eventTime.toISOString(),
          canonical.kind,
          canonical.redactionPolicyVersion,
          params.requestedBy,
          canonical.origin,
          translationModelName,
          translationModel,
          resp.promptVersion, // aimer#495 response promptVersion
        ],
      );
      inserted = (ins.rowCount ?? 0) > 0;
      await writeClient.query("COMMIT");
    } catch (err) {
      await writeClient.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      writeClient.release();
    }
  } catch (err) {
    return {
      kind: "error",
      errorCode: "storage_failed",
      message: err instanceof Error ? err.message : "storage failed",
    };
  }

  if (!inserted) {
    // A concurrent derivation materialized the same generation first.
    return { kind: "noop", generation: canonical.generation };
  }

  void auditLog({
    ...auditBase,
    action: "ai_analysis.result_stored",
    targetId,
    details: {
      lang: targetLang,
      modelName,
      model,
      translate: true,
      restoration_lang: DEFAULT_LANG,
      generation: canonical.generation,
      // Copied from the canonical (never overwritten by the translation).
      prompt_version: canonical.promptVersion,
      model_actual_version: canonical.modelActualVersion,
      // Translation provenance (the aimer#495 footprint).
      translation_model_name: translationModelName,
      translation_model: translationModel,
      translation_prompt_version: resp.promptVersion,
      translation_model_actual_version: resp.modelActualVersion,
    },
  });
  emitMetric("translated", {
    customer_id: auditBase.customerId,
    aice_id: aiceId,
    event_key: eventKey,
    lang: targetLang,
    generation: canonical.generation,
    translation_model_name: translationModelName,
    translation_model: translationModel,
  });

  return { kind: "translated", generation: canonical.generation };
}
