// Auth-DB store for report-variant refresh runs/items (#469).
//
// Persists a refresh run and its per-variant outcomes
// (`report_variant_refresh_runs` / `report_variant_refresh_items`) so the
// refreshed-vs-skipped breakdown (refreshed / capped / gated /
// already_queued / source_unavailable / limited) survives across requests
// (Scope §5). A refresh run is SYNCHRONOUS — it has no background worker, so
// the row is written once, already terminal, in the SAME transaction as the
// `periodic_report_job` generation bumps it records. There is no lease /
// claim / cancel machinery (cf. the #470 event-backfill store), only audit
// persistence + read-back for the UI.
//
// SERVER-ONLY. Auth DB only.

import "server-only";

import type { Pool, PoolClient } from "pg";
import type { TargetVariant } from "./event-leaf-backfill";
import type { PeriodicPeriod } from "./report-input-builder";
import type {
  PlannedVariant,
  RefreshCounts,
  RefreshOutcome,
  RefreshScope,
} from "./report-refresh";

export type RunStatus = "running" | "completed" | "failed";

export interface RefreshRun extends RefreshCounts {
  id: string;
  customerId: string;
  lang: string;
  modelName: string;
  model: string;
  windowDays: number;
  windowStart: string;
  windowEnd: string;
  periods: PeriodicPeriod[];
  maxVariants: number | null;
  status: RunStatus;
  errorMessage: string | null;
  createdBy: string | null;
  createdAt: string;
  finishedAt: string | null;
}

export interface RefreshRunItem {
  period: PeriodicPeriod;
  bucketDate: string;
  tz: string;
  lang: string;
  modelName: string;
  model: string;
  category: RefreshOutcome;
  generation: number | null;
  windowStart: string;
  windowEnd: string;
}

interface RunRow {
  id: string;
  customer_id: string;
  lang: string;
  model_name: string;
  model: string;
  window_days: number;
  window_start: Date | string;
  window_end: Date | string;
  periods: string[];
  max_variants: number | null;
  status: RunStatus;
  total_variants: number;
  refreshed_count: number;
  capped_count: number;
  gated_count: number;
  already_queued_count: number;
  source_unavailable_count: number;
  limited_count: number;
  error_message: string | null;
  created_by: string | null;
  created_at: Date | string;
  finished_at: Date | string | null;
}

function iso(v: Date | string): string {
  return v instanceof Date ? v.toISOString() : String(v);
}

function isoOrNull(v: Date | string | null): string | null {
  return v == null ? null : iso(v);
}

function mapRun(r: RunRow): RefreshRun {
  return {
    id: r.id,
    customerId: r.customer_id,
    lang: r.lang,
    modelName: r.model_name,
    model: r.model,
    windowDays: r.window_days,
    windowStart: iso(r.window_start),
    windowEnd: iso(r.window_end),
    periods: r.periods as PeriodicPeriod[],
    maxVariants: r.max_variants,
    status: r.status,
    totalVariants: r.total_variants,
    refreshed: r.refreshed_count,
    capped: r.capped_count,
    gated: r.gated_count,
    alreadyQueued: r.already_queued_count,
    sourceUnavailable: r.source_unavailable_count,
    limited: r.limited_count,
    errorMessage: r.error_message,
    createdBy: r.created_by,
    createdAt: iso(r.created_at),
    finishedAt: isoOrNull(r.finished_at),
  };
}

const RUN_COLUMNS = `id, customer_id, lang, model_name, model,
    window_days, window_start, window_end, periods, max_variants, status,
    total_variants, refreshed_count, capped_count, gated_count,
    already_queued_count, source_unavailable_count, limited_count,
    error_message, created_by, created_at, finished_at`;

export interface RecordRunParams {
  scope: RefreshScope;
  target: TargetVariant;
  windowStart: Date;
  windowEnd: Date;
  counts: RefreshCounts;
  variants: PlannedVariant[];
  createdBy: string;
  now: Date;
}

/**
 * Insert a completed refresh run and its per-variant items in one statement
 * pair, on the caller's transaction client (the same transaction that
 * performed the `periodic_report_job` bumps, so the audit record and the
 * bumps commit atomically). Returns the persisted run.
 */
export async function recordRun(
  client: PoolClient,
  params: RecordRunParams,
): Promise<RefreshRun> {
  const { scope, target, counts, now } = params;
  const insertRun = await client.query<RunRow>(
    `INSERT INTO report_variant_refresh_runs
       (customer_id, lang, model_name, model,
        window_days, window_start, window_end, periods, max_variants,
        status, total_variants, refreshed_count, capped_count, gated_count,
        already_queued_count, source_unavailable_count, limited_count,
        created_by, finished_at)
     VALUES ($1, $2, $3, $4, $5, $6::timestamptz, $7::timestamptz,
             $8::text[], $9, 'completed', $10, $11, $12, $13, $14, $15, $16,
             $17, $18::timestamptz)
     RETURNING ${RUN_COLUMNS}`,
    [
      scope.customerId,
      target.lang,
      target.modelName,
      target.model,
      scope.windowDays,
      params.windowStart.toISOString(),
      params.windowEnd.toISOString(),
      scope.periods,
      scope.maxVariants,
      counts.totalVariants,
      counts.refreshed,
      counts.capped,
      counts.gated,
      counts.alreadyQueued,
      counts.sourceUnavailable,
      counts.limited,
      params.createdBy,
      now.toISOString(),
    ],
  );
  const run = mapRun(insertRun.rows[0]);

  if (params.variants.length > 0) {
    const periods: string[] = [];
    const bucketDates: string[] = [];
    const tzs: string[] = [];
    const langs: string[] = [];
    const modelNames: string[] = [];
    const models: string[] = [];
    const categories: string[] = [];
    const generations: Array<number | null> = [];
    const windowStarts: string[] = [];
    const windowEnds: string[] = [];
    for (const v of params.variants) {
      periods.push(v.period);
      bucketDates.push(v.bucketDate);
      tzs.push(v.tz);
      langs.push(v.lang);
      modelNames.push(v.modelName);
      models.push(v.model);
      categories.push(v.outcome);
      generations.push(v.generation ?? null);
      windowStarts.push(v.windowStart);
      windowEnds.push(v.windowEnd);
    }
    await client.query(
      `INSERT INTO report_variant_refresh_items
         (run_id, period, bucket_date, tz, lang, model_name, model,
          category, generation, window_start, window_end)
       SELECT $1, p, b::date, z, l, mn, m, c, g, ws::timestamptz, we::timestamptz
         FROM unnest($2::text[], $3::text[], $4::text[], $5::text[],
                     $6::text[], $7::text[], $8::text[], $9::int[],
                     $10::text[], $11::text[])
              AS w(p, b, z, l, mn, m, c, g, ws, we)`,
      [
        run.id,
        periods,
        bucketDates,
        tzs,
        langs,
        modelNames,
        models,
        categories,
        generations,
        windowStarts,
        windowEnds,
      ],
    );
  }
  return run;
}

/** List recent refresh runs for a customer (most recent first). */
export async function listRuns(
  client: Pool | PoolClient,
  customerId: string,
  limit = 20,
): Promise<RefreshRun[]> {
  const { rows } = await client.query<RunRow>(
    `SELECT ${RUN_COLUMNS}
       FROM report_variant_refresh_runs
      WHERE customer_id = $1
      ORDER BY created_at DESC
      LIMIT $2`,
    [customerId, limit],
  );
  return rows.map(mapRun);
}

/** Fetch a run by id, scoped to a customer for authz safety. */
export async function getRun(
  client: Pool | PoolClient,
  customerId: string,
  runId: string,
): Promise<RefreshRun | null> {
  const { rows } = await client.query<RunRow>(
    `SELECT ${RUN_COLUMNS}
       FROM report_variant_refresh_runs
      WHERE id = $1 AND customer_id = $2`,
    [runId, customerId],
  );
  return rows[0] ? mapRun(rows[0]) : null;
}

/** Fetch the per-variant outcome rows for a run (for the audit drill-down). */
export async function getRunItems(
  client: Pool | PoolClient,
  runId: string,
): Promise<RefreshRunItem[]> {
  const { rows } = await client.query<{
    period: PeriodicPeriod;
    bucket_date: string;
    tz: string;
    lang: string;
    model_name: string;
    model: string;
    category: RefreshOutcome;
    generation: number | null;
    window_start: Date | string;
    window_end: Date | string;
  }>(
    `SELECT period, to_char(bucket_date, 'YYYY-MM-DD') AS bucket_date, tz,
            lang, model_name, model, category, generation,
            window_start, window_end
       FROM report_variant_refresh_items
      WHERE run_id = $1
      ORDER BY period, bucket_date DESC, tz`,
    [runId],
  );
  return rows.map((r) => ({
    period: r.period,
    bucketDate: r.bucket_date,
    tz: r.tz,
    lang: r.lang,
    modelName: r.model_name,
    model: r.model,
    category: r.category,
    generation: r.generation,
    windowStart: iso(r.window_start),
    windowEnd: iso(r.window_end),
  }));
}
