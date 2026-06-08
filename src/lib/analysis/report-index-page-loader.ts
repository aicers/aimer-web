// Server-side loader for the periodic report index/landing page
// (`/[locale]/customers/{customerId}/analysis/reports`).
//
// The detail loader (`report-result-page-loader.ts`) resolves ONE
// `(period, bucket_date, tz)` bucket; this loader answers "which report
// buckets exist for this customer at all?" so the index can list them and
// link into the detail page.
//
// Bucket discovery is the auth-DB `periodic_report_state` table, non-
// archived rows only (`status IN ('pending','ready','dirty')`). That is
// the source of truth: a bucket the worker is tracking but has not yet
// produced a result for still appears here (mirroring the detail page's
// "being generated" state), so result metadata is optional enrichment,
// not the discovery key.
//
// Auth DB and the customer DB are separate pools and cannot be JOINed
// (same constraint as `report-input-builder.ts`), so discovery reads the
// state rows from auth first, then enriches each with the customer-DB
// `periodic_report_result` latest non-superseded default variant in a
// second step.

import "server-only";

import type { Pool } from "pg";
import {
  type AppLocale,
  appLocaleToReportLanguage,
  isSupportedLocale,
  type ReportLanguage,
  reportLanguageToAppLocale,
} from "@/i18n/locale";
import { authorize } from "@/lib/auth/authorization";
import { getAuthCookie } from "@/lib/auth/cookies";
import { verifyJwtFull } from "@/lib/auth/jwt";
import { getSessionPolicy } from "@/lib/auth/session-policy";
import { validateSession } from "@/lib/auth/session-validator";
import { getAuthPool, withTransaction } from "@/lib/db/client";
import { getCustomerRuntimePool } from "@/lib/db/customer-runtime-pool";
import { resolveDefaultModel } from "./default-model";
import type { PriorityTier } from "./priority-tier";
import type { PeriodKind } from "./report-bucket-date";

// English is the guaranteed baseline (parent #386), the second link in the
// per-bucket fallback chain (viewer language → English → any available).
const ENGLISH_BASELINE: ReportLanguage = "ENGLISH";

// Per-period cap on the recent-bucket list so the index never renders an
// unbounded list (#369). LIVE is a single rolling bucket; the calendar
// periods keep a bounded recent window. Tunable via env for operators who
// want a longer history without a code change.
function envCap(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export const PERIOD_CAPS: Record<PeriodKind, number> = {
  LIVE: envCap("ANALYSIS_REPORT_INDEX_CAP_LIVE", 1),
  DAILY: envCap("ANALYSIS_REPORT_INDEX_CAP_DAILY", 14),
  WEEKLY: envCap("ANALYSIS_REPORT_INDEX_CAP_WEEKLY", 8),
  MONTHLY: envCap("ANALYSIS_REPORT_INDEX_CAP_MONTHLY", 12),
};

// Render order: LIVE first (the rolling "now" view), then the calendar
// periods from shortest to longest window.
export const PERIOD_ORDER: readonly PeriodKind[] = [
  "LIVE",
  "DAILY",
  "WEEKLY",
  "MONTHLY",
];

export type StateStatus = "pending" | "ready" | "dirty";

/** Result metadata for a bucket's default variant (optional enrichment). */
export interface ReportBucketResult {
  priorityTier: PriorityTier;
  generation: number;
  requestedBy: string | null;
  requestedAt: Date;
}

export interface ReportBucketItem {
  period: PeriodKind;
  /** `YYYY-MM-DD`; the synthetic `1970-01-01` for LIVE. */
  bucketDate: string;
  /** The state row's bucket tz — pinned on the detail link (`?tz=`). */
  tz: string;
  stateStatus: StateStatus;
  /**
   * Latest non-superseded result for this bucket resolved to the viewer's
   * language (viewer language → English → any available), or null when no
   * result exists yet. Resolved per bucket so a `ko` viewer never silently
   * sees an English tier where a `ko` result exists (#388).
   */
  result: ReportBucketResult | null;
  /**
   * The languages with a stored result for this bucket's default-model
   * variant, as app-locale codes (for a per-bucket availability hint).
   */
  availableLocales: AppLocale[];
  /** Language `result` was resolved to, as an app-locale code; null when none. */
  resolvedLocale: AppLocale | null;
}

export interface ReportPeriodGroup {
  period: PeriodKind;
  items: ReportBucketItem[];
}

export type ReportIndexPageOutcome =
  | { kind: "unauthorized" }
  | { kind: "forbidden" }
  | { kind: "ok"; groups: ReportPeriodGroup[] };

export interface ReportIndexPageInput {
  customerId: string;
  /**
   * The viewer's resolved app locale (the page's `[locale]` route param).
   * Drives the per-bucket viewer-language fallback. Defaults to the English
   * baseline when absent / unrecognized.
   */
  locale?: string;
}

interface StateRow {
  period: PeriodKind;
  bucket_date: string;
  tz: string;
  status: StateStatus;
}

export async function loadReportIndexPage(
  input: ReportIndexPageInput,
): Promise<ReportIndexPageOutcome> {
  const token = await getAuthCookie("general");
  if (!token) return { kind: "unauthorized" };
  let claims: Awaited<ReturnType<typeof verifyJwtFull>>;
  try {
    claims = await verifyJwtFull(token, "general");
  } catch {
    return { kind: "unauthorized" };
  }

  const authPool = getAuthPool();

  let bridgeAiceId: string | null = null;
  let bridgeCustomerIds: string[] | null = null;
  try {
    const policy = await getSessionPolicy();
    const session = await validateSession(authPool, claims.sid, policy.general);
    bridgeAiceId = session.bridgeAiceId;
    bridgeCustomerIds = session.bridgeCustomerIds;
  } catch {
    return { kind: "unauthorized" };
  }

  const auth = await withTransaction(authPool, (client) =>
    authorize(client, "general", claims.sub, "reports:read", {
      customerId: input.customerId,
      operationKind: "read",
      // Bridge sessions cannot read these surfaces (round-15 S3): an
      // in-scope bridge → 403, mirroring the detail page and the
      // regenerate/summary endpoints.
      allowInBridge: false,
      bridgeScope: bridgeCustomerIds
        ? { aiceId: bridgeAiceId ?? "", customerIds: bridgeCustomerIds }
        : null,
    }),
  );
  if (!auth.authorized) {
    // Same mapping as the detail loader: bridge denial and member-without-
    // permission → 403; non-membership / non-existent customer → 404
    // (existence-hiding). `authorizeGeneral` returns a `permissions` set
    // for members (even without the required permission) and leaves it
    // undefined for non-members; a `reason` is only set for bridge denials.
    if (auth.reason === "bridge_not_allowed") return { kind: "forbidden" };
    if (auth.permissions !== undefined) return { kind: "forbidden" };
    return { kind: "unauthorized" };
  }

  const viewerLanguage = isSupportedLocale(input.locale)
    ? appLocaleToReportLanguage(input.locale)
    : ENGLISH_BASELINE;
  const groups = await discoverReportBuckets(
    authPool,
    getCustomerRuntimePool(input.customerId),
    input.customerId,
    viewerLanguage,
  );
  return { kind: "ok", groups };
}

/**
 * Pure bucket discovery + enrichment + grouping, without the auth
 * preamble — exported so the staged cross-DB query path can be exercised
 * by a db test (the auth path needs a real cookie/JWT/session and is
 * covered by the page unit test instead).
 *
 * `viewerLanguage` selects which language's result enriches each bucket via
 * the per-bucket fallback chain (viewer language → English → any available);
 * it defaults to the English baseline so callers that don't care (and the
 * existing db test) keep the prior English-default behavior.
 */
export async function discoverReportBuckets(
  authPool: Pool,
  customerPool: Pool,
  customerId: string,
  viewerLanguage: ReportLanguage = ENGLISH_BASELINE,
): Promise<ReportPeriodGroup[]> {
  // --- Discovery (auth DB): non-archived state rows, capped per period --
  // The cap is applied in SQL (ROW_NUMBER per period) so the index never
  // reads or renders an unbounded list. LIVE's bucket_date is the synthetic
  // epoch constant, so its ranking falls through to `updated_at DESC` and
  // keeps the most recently active rolling row.
  const stateRows = await authPool.query<StateRow>(
    `WITH ranked AS (
       SELECT period, bucket_date::text AS bucket_date, tz, status,
              ROW_NUMBER() OVER (
                PARTITION BY period
                ORDER BY bucket_date DESC, updated_at DESC, tz ASC
              ) AS rn
         FROM periodic_report_state
        WHERE customer_id = $1
          AND status IN ('pending', 'ready', 'dirty')
     )
     SELECT period, bucket_date, tz, status
       FROM ranked
      WHERE (period = 'LIVE'    AND rn <= $2)
         OR (period = 'DAILY'   AND rn <= $3)
         OR (period = 'WEEKLY'  AND rn <= $4)
         OR (period = 'MONTHLY' AND rn <= $5)
      ORDER BY period, bucket_date DESC, tz ASC`,
    [
      customerId,
      PERIOD_CAPS.LIVE,
      PERIOD_CAPS.DAILY,
      PERIOD_CAPS.WEEKLY,
      PERIOD_CAPS.MONTHLY,
    ],
  );

  const items: ReportBucketItem[] = stateRows.rows.map((r) => ({
    period: r.period,
    bucketDate: r.bucket_date,
    tz: r.tz,
    stateStatus: r.status,
    result: null,
    availableLocales: [],
    resolvedLocale: null,
  }));

  // --- Enrichment (customer DB): latest non-superseded result per bucket AND
  // language, at the default model variant. The default variant matches
  // `tz = state.tz` (the row's bucket tz, NOT the customer's current timezone
  // — those differ after a tz change) and the customer's resolved default
  // `(model_name, model)` (#473 — per-customer override → admin global → env).
  // Unlike the prior pass this is NOT pinned to a single language:
  // it returns every available language per bucket so the result can be
  // resolved to the viewer's language with the fallback chain (#388), and the
  // available-language set can drive the per-bucket hint + switcher. Best-
  // effort: discovery is the source of truth, so an enrichment failure (e.g.
  // customer DB unavailable) degrades to links-only rather than failing.
  if (items.length > 0) {
    try {
      const defaultPair = await resolveDefaultModel(customerId, authPool);
      const periods = items.map((i) => i.period);
      const bucketDates = items.map((i) => i.bucketDate);
      const tzs = items.map((i) => i.tz);
      const resultRows = await customerPool.query<{
        period: PeriodKind;
        bucket_date: string;
        tz: string;
        lang: string;
        priority_tier: PriorityTier;
        generation: number;
        requested_by: string | null;
        requested_at: Date;
      }>(
        `WITH wanted(period, bucket_date, tz) AS (
           SELECT p, d::date, z
             FROM unnest($1::text[], $2::date[], $3::text[]) AS u(p, d, z)
         )
         SELECT DISTINCT ON (r.period, r.bucket_date, r.tz, r.lang)
                r.period, r.bucket_date::text AS bucket_date, r.tz, r.lang,
                r.priority_tier, r.generation,
                r.requested_by::text AS requested_by, r.requested_at
           FROM periodic_report_result r
           JOIN wanted w
             ON w.period = r.period
            AND w.bucket_date = r.bucket_date
            AND w.tz = r.tz
          WHERE r.customer_id = $4
            AND r.model_name = $5 AND r.model = $6
            AND r.superseded_at IS NULL
          ORDER BY r.period, r.bucket_date, r.tz, r.lang, r.generation DESC`,
        [
          periods,
          bucketDates,
          tzs,
          customerId,
          defaultPair.modelName,
          defaultPair.model,
        ],
      );
      // Group the per-(bucket, language) winners by bucket so each bucket can
      // resolve its own viewer-language fallback.
      const byBucket = new Map<string, Map<string, ReportBucketResult>>();
      for (const row of resultRows.rows) {
        const key = `${row.period}|${row.bucket_date}|${row.tz}`;
        let langs = byBucket.get(key);
        if (!langs) {
          langs = new Map();
          byBucket.set(key, langs);
        }
        langs.set(row.lang, {
          priorityTier: row.priority_tier,
          generation: row.generation,
          requestedBy: row.requested_by,
          requestedAt: row.requested_at,
        });
      }
      for (const item of items) {
        const langs = byBucket.get(
          `${item.period}|${item.bucketDate}|${item.tz}`,
        );
        if (!langs) continue;
        item.availableLocales = [...langs.keys()]
          .filter((l): l is ReportLanguage => l === "ENGLISH" || l === "KOREAN")
          .map(reportLanguageToAppLocale)
          .sort();
        // Fallback chain: viewer language → English → any available.
        const resolvedLang =
          (langs.has(viewerLanguage) && viewerLanguage) ||
          (langs.has(ENGLISH_BASELINE) && ENGLISH_BASELINE) ||
          [...langs.keys()].sort()[0];
        if (resolvedLang) {
          item.result = langs.get(resolvedLang) ?? null;
          item.resolvedLocale =
            resolvedLang === "ENGLISH" || resolvedLang === "KOREAN"
              ? reportLanguageToAppLocale(resolvedLang)
              : null;
        }
      }
    } catch {
      // Leave every item links-only on failure.
    }
  }

  // Group into the fixed period order, dropping periods with no buckets.
  const groups: ReportPeriodGroup[] = [];
  for (const period of PERIOD_ORDER) {
    const periodItems = items.filter((i) => i.period === period);
    if (periodItems.length > 0) groups.push({ period, items: periodItems });
  }

  return groups;
}
