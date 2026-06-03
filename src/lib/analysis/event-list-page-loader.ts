// Server-side loader for the customer-scoped Suspicious Events list page
// (`/[locale]/customers/{customerId}/analysis/events`) — WS3 (#392).
//
// This is a NEW customer-level segment: the event detail route is
// per-`aice_id` (`aice/{aiceId}/events/{eventKey}/analysis`), but a
// customer-wide list spans many `aice_id`s, so it cannot live under
// `aice/{aiceId}/...`.
//
// The list shows ANALYZED events sourced entirely from the customer-DB
// `event_analysis_result` table — the only table carrying `event_key` +
// priority + scores. Raw un-analyzed `detection_events` lack
// `event_key`/priority and are out of scope.
//
// Canonical variant: one row per `(aice_id, event_key)` — latest
// `generation`, default `(lang, model_name, model)`, `superseded_at IS
// NULL` — selected via `DISTINCT ON`. Ordering and keyset pagination then
// run natively in the same query.
//
// Ordering (high-risk first), every direction pinned:
//   priority_rank DESC, severity_score DESC, likelihood_score DESC,
//   requested_at DESC, aice_id ASC, event_key ASC
// `priority_rank` is the integer rank, never the raw `priority_tier` text.

import "server-only";

import type { Pool } from "pg";
import { getCustomerRuntimePool } from "@/lib/db/customer-runtime-pool";
import { resolveCustomerReadAccess } from "./customer-read-access";
import { decodeCursor, encodeCursor } from "./keyset-cursor";
import { type PriorityTier, priorityRankCaseSql } from "./priority-tier";

const DEFAULT_LANG = process.env.ANALYSIS_DEFAULT_LANG ?? "ENGLISH";
const DEFAULT_MODEL_NAME = process.env.ANALYSIS_DEFAULT_MODEL_NAME ?? "openai";
const DEFAULT_MODEL = process.env.ANALYSIS_DEFAULT_MODEL ?? "gpt-4o";

export const DEFAULT_PAGE_SIZE = 25;

export interface EventListItem {
  aiceId: string;
  /** `event_key` as a decimal text (NUMERIC(39,0)). */
  eventKey: string;
  priorityTier: PriorityTier;
  severityScore: number;
  likelihoodScore: number;
  requestedAt: Date;
}

export interface EventListPage {
  items: EventListItem[];
  nextCursor: string | null;
  /** The canonical variant these rows resolve to — pinned on detail links. */
  variant: { lang: string; modelName: string; model: string };
}

export type EventListPageOutcome =
  | { kind: "unauthorized" }
  | { kind: "forbidden" }
  | { kind: "ok"; page: EventListPage };

export interface EventListFilters {
  priorityTier?: PriorityTier | null;
  since?: Date | null;
}

export interface EventListPageInput extends EventListFilters {
  customerId: string;
  cursor?: string | null;
  pageSize?: number;
}

interface EventCursor {
  pr: number;
  ss: number;
  ls: number;
  /** `requested_at` as a full-precision timestamptz text. */
  rt: string;
  aid: string;
  /** `event_key` as a decimal text. */
  ek: string;
}

function isEventCursor(value: unknown): value is EventCursor {
  if (typeof value !== "object" || value === null) return false;
  const c = value as Record<string, unknown>;
  return (
    typeof c.pr === "number" &&
    typeof c.ss === "number" &&
    typeof c.ls === "number" &&
    typeof c.rt === "string" &&
    typeof c.aid === "string" &&
    typeof c.ek === "string"
  );
}

export async function loadEventListPage(
  input: EventListPageInput,
): Promise<EventListPageOutcome> {
  const access = await resolveCustomerReadAccess(input.customerId);
  if (access.kind !== "ok") return access;
  // Suspicious-events section requires `analyses:read`; member-without-it is
  // a real 403.
  if (!access.permissions.has("analyses:read")) return { kind: "forbidden" };

  const page = await queryEventListPage(
    getCustomerRuntimePool(input.customerId),
    input,
  );
  return { kind: "ok", page };
}

/**
 * Pure query path without the auth preamble — exported for DB testing.
 */
export async function queryEventListPage(
  customerPool: Pool,
  input: EventListPageInput,
): Promise<EventListPage> {
  const pageSize =
    input.pageSize && input.pageSize > 0 ? input.pageSize : DEFAULT_PAGE_SIZE;

  const params: unknown[] = [];
  const p = (value: unknown): string => {
    params.push(value);
    return `$${params.length}`;
  };

  const rankCase = priorityRankCaseSql("priority_tier");

  const lang = p(DEFAULT_LANG);
  const modelName = p(DEFAULT_MODEL_NAME);
  const model = p(DEFAULT_MODEL);

  const rankedConds: string[] = [];
  if (input.priorityTier) {
    rankedConds.push(`priority_tier = ${p(input.priorityTier)}`);
  }
  if (input.since) {
    rankedConds.push(
      `requested_at >= ${p(input.since.toISOString())}::timestamptz`,
    );
  }
  const rankedWhere =
    rankedConds.length > 0 ? `WHERE ${rankedConds.join(" AND ")}` : "";

  const cursor = decodeCursor(input.cursor, isEventCursor);
  let keyset = "";
  if (cursor) {
    const pr = p(cursor.pr);
    const ss = p(cursor.ss);
    const ls = p(cursor.ls);
    const rt = p(cursor.rt);
    const aid = p(cursor.aid);
    const ek = p(cursor.ek);
    keyset =
      `WHERE (priority_rank < ${pr})\n` +
      `   OR (priority_rank = ${pr} AND severity_score < ${ss})\n` +
      `   OR (priority_rank = ${pr} AND severity_score = ${ss} AND likelihood_score < ${ls})\n` +
      `   OR (priority_rank = ${pr} AND severity_score = ${ss} AND likelihood_score = ${ls} AND requested_at < ${rt}::timestamptz)\n` +
      `   OR (priority_rank = ${pr} AND severity_score = ${ss} AND likelihood_score = ${ls} AND requested_at = ${rt}::timestamptz AND aice_id > ${aid})\n` +
      `   OR (priority_rank = ${pr} AND severity_score = ${ss} AND likelihood_score = ${ls} AND requested_at = ${rt}::timestamptz AND aice_id = ${aid} AND event_key > ${ek}::numeric)`;
  }

  const limit = p(pageSize + 1);

  // `canonical` resolves one row per (aice_id, event_key) — the latest
  // generation of the default variant that is not superseded. `ranked`
  // then applies filters + the integer rank; the outer SELECT applies the
  // keyset seek, ordering, and limit.
  const sql = `WITH canonical AS (
       SELECT DISTINCT ON (aice_id, event_key)
              aice_id,
              event_key,
              priority_tier,
              severity_score,
              likelihood_score,
              requested_at
         FROM event_analysis_result
        WHERE lang = ${lang} AND model_name = ${modelName} AND model = ${model}
          AND superseded_at IS NULL
        ORDER BY aice_id, event_key, generation DESC
     ),
     ranked AS (
       SELECT aice_id,
              event_key,
              priority_tier,
              severity_score,
              likelihood_score,
              requested_at,
              ${rankCase} AS priority_rank
         FROM canonical
       ${rankedWhere}
     )
     SELECT aice_id,
            event_key::text AS event_key,
            priority_tier,
            severity_score,
            likelihood_score,
            requested_at::text AS requested_at,
            priority_rank
       FROM ranked
     ${keyset}
      ORDER BY priority_rank DESC, severity_score DESC, likelihood_score DESC,
               requested_at DESC, aice_id ASC, event_key ASC
      LIMIT ${limit}`;

  const result = await customerPool.query<{
    aice_id: string;
    event_key: string;
    priority_tier: PriorityTier;
    severity_score: number;
    likelihood_score: number;
    requested_at: string;
    priority_rank: number;
  }>(sql, params);

  const rows = result.rows;
  const hasMore = rows.length > pageSize;
  const pageRows = hasMore ? rows.slice(0, pageSize) : rows;

  const items: EventListItem[] = pageRows.map((r) => ({
    aiceId: r.aice_id,
    eventKey: r.event_key,
    priorityTier: r.priority_tier,
    severityScore: r.severity_score,
    likelihoodScore: r.likelihood_score,
    requestedAt: new Date(r.requested_at),
  }));

  let nextCursor: string | null = null;
  if (hasMore) {
    const last = pageRows[pageRows.length - 1];
    nextCursor = encodeCursor({
      pr: last.priority_rank,
      ss: last.severity_score,
      ls: last.likelihood_score,
      rt: last.requested_at,
      aid: last.aice_id,
      ek: last.event_key,
    } satisfies EventCursor);
  }

  return {
    items,
    nextCursor,
    variant: {
      lang: DEFAULT_LANG,
      modelName: DEFAULT_MODEL_NAME,
      model: DEFAULT_MODEL,
    },
  };
}
