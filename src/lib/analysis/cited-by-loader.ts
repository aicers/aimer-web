// Reverse-citation lookup for the "Cited by" trail (T2, #396).
//
// T1 (#395) owns the forward direction (report → cited leaf, via the
// Sources panel). This module owns the *reverse*: given a leaf — a
// suspicious event `(aiceId, eventKey)` or a threat story `storyId`, at a
// specific `generation` — find the periodic report(s) that cited THAT
// generation, so the leaf detail pages can render a "Cited by" trail back
// up the trust chain.
//
// Data source: `periodic_report_result.input_event_refs` /
// `input_story_refs`, the same generation-stamped ref lists the Sources
// panel reads forward (`report-input-builder.ts` persists each ref as
// `{aice_id, event_key, generation}` / `{story_id, generation}`). The
// lookup is a JSONB containment (`@>`) scan backed by the GIN indexes in
// migration 0009.
//
// Contract (parent #386 / #396):
//   - Scoped strictly to the page's `customerId` / customer DB. Reports
//     live in the per-customer runtime DB, so a containment match is
//     necessarily within one customer; we never widen across pools.
//   - Permission-gated on `reports:read` (the trail links INTO report
//     detail pages). A viewer without it — or an unauthenticated /
//     bridge session — gets an empty trail, never a leak: the leaf page
//     simply renders no trail.
//   - Generation-pinned on BOTH ends. The probe carries the cited leaf
//     `generation`, so a leaf page opened at generation N only surfaces
//     reports that cited generation N — not reports that cited some other
//     generation of the same id (their Sources link would point at a
//     different variant, breaking the exact-evidence round trip). Each
//     returned entry also carries the citing report's `generation` so the
//     link lands on the exact citing variant (the report page honors
//     `?generation`).
//   - Multiple allowed, newest-first: a leaf can be cited across many
//     periods; entries are deduped to one per report bucket and ordered
//     most-recent-citing-report first. No citations → empty list (not an
//     error).

import "server-only";

import { type AppLocale, reportLanguageToAppLocale } from "@/i18n/locale";
import { authorize } from "@/lib/auth/authorization";
import { getAuthCookie } from "@/lib/auth/cookies";
import { verifyJwtFull } from "@/lib/auth/jwt";
import { getSessionPolicy } from "@/lib/auth/session-policy";
import { validateSession } from "@/lib/auth/session-validator";
import { getAuthPool, withTransaction } from "@/lib/db/client";
import { getCustomerRuntimePool } from "@/lib/db/customer-runtime-pool";
import type { PriorityTier } from "./priority-tier";

/**
 * The leaf whose citing reports we look up. `generation` is the leaf
 * generation currently loaded on the detail page (pinned or latest); the
 * probe matches it so the trail reflects what cited THIS generation, not
 * any generation of the same id.
 */
export type CitedByLeaf =
  | {
      kind: "event";
      aiceId: string;
      eventKey: string;
      generation: number;
      /**
       * The leaf's own `(model_name, model)` (#465 Scope 4). `generation` is
       * variant-scoped — the `story_analysis_result` / `event_analysis_result`
       * PKs include `model_name`/`model`, so `(id, generation)` collides across
       * models. The probe pins the model so a report that cited a DIFFERENT
       * model's same-generation leaf does not appear in this trail.
       */
      modelName: string;
      model: string;
    }
  | {
      kind: "story";
      storyId: string;
      generation: number;
      modelName: string;
      model: string;
    };

/**
 * One citing report in the trail. Carries everything the link needs to
 * land on the exact citing variant + generation, plus a tier badge.
 * `bucketDate` is a `YYYY-MM-DD` string (the report bucket day; LIVE
 * carries the synthetic epoch bucket). `locale` is the citing row's
 * report language mapped to an app-locale code for the `?lang` param.
 */
export interface CitedByReport {
  period: string;
  bucketDate: string;
  tz: string;
  locale: AppLocale;
  modelName: string;
  model: string;
  generation: number;
  priorityTier: PriorityTier;
  requestedAt: Date;
}

export interface CitedByInput {
  customerId: string;
  leaf: CitedByLeaf;
}

interface CitingRow {
  period: string;
  bucket_date: string;
  tz: string;
  lang: string;
  model_name: string;
  model: string;
  generation: number;
  priority_tier: PriorityTier;
  requested_at: Date;
}

/**
 * Resolve the reports citing `leaf`, newest-first, deduped per report
 * bucket. Returns an empty array on any auth failure or when no report
 * cites the leaf — callers render "no trail", never an error.
 */
export async function loadCitedByReports(
  input: CitedByInput,
): Promise<CitedByReport[]> {
  // Independent auth: the trail can render on a leaf page the viewer
  // reached with `analyses:read`, but the reports it links to need
  // `reports:read`. Gate on it here so the trail never surfaces a report
  // the viewer cannot open. Any failure short-circuits to an empty trail.
  const token = await getAuthCookie("general");
  if (!token) return [];
  let claims: Awaited<ReturnType<typeof verifyJwtFull>>;
  try {
    claims = await verifyJwtFull(token, "general");
  } catch {
    return [];
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
    return [];
  }

  const auth = await withTransaction(authPool, (client) =>
    authorize(client, "general", claims.sub, "reports:read", {
      customerId: input.customerId,
      operationKind: "read",
      // Mirror the report loader: a bridge session cannot read report
      // surfaces, so it gets no trail (the linked reports would 403).
      allowInBridge: false,
      bridgeScope: bridgeCustomerIds
        ? { aiceId: bridgeAiceId ?? "", customerIds: bridgeCustomerIds }
        : null,
    }),
  );
  if (!auth.authorized) return [];

  // Containment value, matching the persisted ref shapes from
  // `report-input-builder.ts` — snake_case keys, `event_key` as a string
  // (`event_key::text` in the builder), `generation` as a number. Pinning
  // `generation` is what keeps the trail faithful: a report that cited a
  // different generation of the same leaf must NOT appear here.
  //
  // Refs carry `model_name`/`model` post-#465 (Scope 4). The match is a
  // two-branch contract, NOT a naive model-less `@>` (which over-matches: `@>`
  // is partial-object containment, so a model-less probe ALSO matches new
  // model-bearing refs and would re-attribute another model's leaf citation):
  //   - model-bearing branch: exact containment of the requested leaf's model.
  //   - legacy branch: a pre-#465 ref that genuinely LACKS `model_name` (key
  //     absence, since a model-less `@>` over-matches) AND only when the citing
  //     row's own `(model_name, model)` equals the requested leaf's model
  //     (legacy refs were always written under the row's own model, so that is
  //     the correct attribution).
  // The two branches are unioned; neither alone is sufficient.
  const {
    column,
    probe,
    idPredicate,
    idParams,
  }: {
    column: string;
    probe: string;
    idPredicate: string;
    idParams: unknown[];
  } =
    input.leaf.kind === "event"
      ? {
          column: "input_event_refs",
          probe: JSON.stringify([
            {
              aice_id: input.leaf.aiceId,
              event_key: input.leaf.eventKey,
              generation: input.leaf.generation,
              model_name: input.leaf.modelName,
              model: input.leaf.model,
            },
          ]),
          idPredicate: `elem->>'aice_id' = $5 AND elem->>'event_key' = $6
                        AND (elem->>'generation')::int = $7`,
          idParams: [
            input.leaf.aiceId,
            input.leaf.eventKey,
            input.leaf.generation,
          ],
        }
      : {
          column: "input_story_refs",
          probe: JSON.stringify([
            {
              story_id: input.leaf.storyId,
              generation: input.leaf.generation,
              model_name: input.leaf.modelName,
              model: input.leaf.model,
            },
          ]),
          idPredicate: `elem->>'story_id' = $5
                        AND (elem->>'generation')::int = $6`,
          idParams: [input.leaf.storyId, input.leaf.generation],
        };

  const customerPool = getCustomerRuntimePool(input.customerId);
  let rows: CitingRow[];
  try {
    const result = await customerPool.query<CitingRow>(
      // $3/$4 = the requested leaf's model; the legacy branch only attributes a
      // model-less ref when the citing row's own model equals it.
      `SELECT period, bucket_date::text AS bucket_date, tz, lang,
              model_name, model, generation, priority_tier, requested_at
         FROM periodic_report_result
        WHERE customer_id = $1
          AND superseded_at IS NULL
          AND (
            ${column} @> $2::jsonb
            OR (
              model_name = $3 AND model = $4
              AND EXISTS (
                SELECT 1
                  FROM jsonb_array_elements(${column}) AS elem
                 WHERE ${idPredicate}
                   AND NOT (elem ? 'model_name')
              )
            )
          )
        ORDER BY requested_at DESC, generation DESC`,
      [
        input.customerId,
        probe,
        input.leaf.modelName,
        input.leaf.model,
        ...idParams,
      ],
    );
    rows = result.rows;
  } catch {
    // A reverse lookup failure (e.g. transient DB error) must not break
    // the leaf page — degrade to no trail.
    return [];
  }

  // Dedupe to one entry per report bucket `(period, bucket_date, tz)`.
  // A bucket may have several language/model variants citing the same
  // leaf; the rows are already ordered newest-first, so the first row
  // seen for a bucket is its most-recent citing variant — keep that as
  // the representative and drop the rest.
  const seen = new Set<string>();
  const out: CitedByReport[] = [];
  for (const r of rows) {
    const bucketKey = JSON.stringify([r.period, r.bucket_date, r.tz]);
    if (seen.has(bucketKey)) continue;
    seen.add(bucketKey);
    out.push({
      period: r.period,
      bucketDate: r.bucket_date,
      tz: r.tz,
      locale: reportLanguageToAppLocale(
        r.lang === "KOREAN" ? "KOREAN" : "ENGLISH",
      ),
      modelName: r.model_name,
      model: r.model,
      generation: r.generation,
      priorityTier: r.priority_tier,
      requestedAt: r.requested_at,
    });
  }
  return out;
}
