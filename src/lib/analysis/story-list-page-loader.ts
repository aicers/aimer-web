// Server-side loader for the customer-scoped Threat Stories list page
// (`/[locale]/subjects/{customerId}/analysis/story`) — WS3 (#392).
//
// Sibling of the existing `story/{storyId}` detail page. Lists the
// customer's threat stories priority-first with server-side keyset
// pagination. Unlike the report-index loader (which caps by recency in the
// auth DB and enriches priority from the customer DB afterward), this loader
// reads everything from the auth-DB `story_analysis_state` table: WS3
// denormalized the canonical variant's `priority_tier` / `severity_score` /
// `likelihood_score` onto that table precisely so priority-first ordering
// and a stable keyset cursor work in a single query.
//
// Lifecycle filter (see migration 0037): the default list shows `ready` and
// `dirty` rows that have a denormalized result (`priority_tier IS NOT
// NULL`). `pending` rows (no result yet) have NULL priority and are
// excluded; `archived` rows are excluded. `dirty` rows surface their
// last-known denormalized values until the refresh finalizes.
//
// Ordering (high-risk first), every direction pinned so the keyset seek is
// unambiguous:
//   priority_rank DESC, severity_score DESC, likelihood_score DESC,
//   recency_ts DESC, story_id ASC
// where `recency_ts = COALESCE(last_ready_at, updated_at)` and
// `priority_rank` is the integer rank (never the raw `priority_tier` text).

import "server-only";

import type { Pool } from "pg";
import { getAuthPool } from "@/lib/db/client";
import { resolveCustomerReadAccess } from "./customer-read-access";
import { decodeCursor, encodeCursor } from "./keyset-cursor";
import { type PriorityTier, priorityRankCaseSql } from "./priority-tier";

export const DEFAULT_PAGE_SIZE = 25;

export type StoryListStatus = "ready" | "dirty";

export interface StoryListItem {
  storyId: string;
  priorityTier: PriorityTier;
  severityScore: number;
  likelihoodScore: number;
  status: StoryListStatus;
  /** `COALESCE(last_ready_at, updated_at)` — the recency tiebreak. */
  recencyTs: Date;
}

export interface StoryListPage {
  items: StoryListItem[];
  /** Opaque cursor for the next page, or null when this is the last page. */
  nextCursor: string | null;
}

export type StoryListPageOutcome =
  | { kind: "unauthorized" }
  | { kind: "forbidden" }
  | { kind: "ok"; page: StoryListPage };

export interface StoryListFilters {
  /** Exact priority-tier filter; null/undefined means all tiers. */
  priorityTier?: PriorityTier | null;
  /** Lower bound on `recency_ts` (time-window filter); null means no bound. */
  since?: Date | null;
}

export interface StoryListPageInput extends StoryListFilters {
  customerId: string;
  cursor?: string | null;
  pageSize?: number;
}

/** Decoded keyset cursor — every ordering-key component of the last row. */
interface StoryCursor {
  pr: number;
  ss: number;
  ls: number;
  /** `recency_ts` as a full-precision timestamptz text. */
  rt: string;
  /** `story_id` as a decimal text (BIGINT). */
  sid: string;
  /**
   * Frozen time-window lower bound for the whole pagination session, as an
   * ISO timestamp, or `null` for the "all time" window. Pinned at the first
   * page so later pages do not re-derive it from a (later) request clock.
   */
  lb?: string | null;
}

function isStoryCursor(value: unknown): value is StoryCursor {
  if (typeof value !== "object" || value === null) return false;
  const c = value as Record<string, unknown>;
  return (
    typeof c.pr === "number" &&
    typeof c.ss === "number" &&
    typeof c.ls === "number" &&
    typeof c.rt === "string" &&
    typeof c.sid === "string" &&
    (c.lb === undefined || c.lb === null || typeof c.lb === "string")
  );
}

export async function loadStoryListPage(
  input: StoryListPageInput,
): Promise<StoryListPageOutcome> {
  const access = await resolveCustomerReadAccess(input.customerId);
  if (access.kind !== "ok") return access;
  // Threat-stories section requires `analyses:read`; a member without it is
  // a real 403 (not an existence-hiding 404), matching the report-index
  // bridge/member denial mapping.
  if (!access.permissions.has("analyses:read")) return { kind: "forbidden" };

  const page = await queryStoryListPage(getAuthPool(), input);
  return { kind: "ok", page };
}

/**
 * Pure query path without the auth preamble — exported so the keyset /
 * ordering / filter behavior can be exercised by a DB test against a real
 * auth pool (the auth path needs a cookie/JWT/session and is covered by the
 * page unit test instead).
 */
export async function queryStoryListPage(
  authPool: Pool,
  input: StoryListPageInput,
): Promise<StoryListPage> {
  const pageSize =
    input.pageSize && input.pageSize > 0 ? input.pageSize : DEFAULT_PAGE_SIZE;

  // Params are pushed positionally; `p()` returns the `$n` placeholder.
  const params: unknown[] = [];
  const p = (value: unknown): string => {
    params.push(value);
    return `$${params.length}`;
  };

  const rankCase = priorityRankCaseSql("priority_tier");

  const cursor = decodeCursor(input.cursor, isStoryCursor);

  // The time-window lower bound is frozen at the first page and carried in the
  // cursor so every page of one pagination session filters against the SAME
  // `since`. Re-deriving it from the request clock would shift the bound
  // forward between pages (page 2 is requested later than page 1) and drop
  // rows near the boundary, breaking keyset stability while a window is active.
  // `lb === null` means the "all time" window; an absent `lb` (pre-fix cursor)
  // falls back to the request's `since`.
  const since =
    cursor && cursor.lb !== undefined
      ? cursor.lb === null
        ? null
        : new Date(cursor.lb)
      : (input.since ?? null);

  const baseConds = [
    `customer_id = ${p(input.customerId)}`,
    `status <> 'archived'`,
    `priority_tier IS NOT NULL`,
  ];
  if (input.priorityTier) {
    baseConds.push(`priority_tier = ${p(input.priorityTier)}`);
  }
  if (since) {
    baseConds.push(
      `COALESCE(last_ready_at, updated_at) >= ${p(since.toISOString())}::timestamptz`,
    );
  }

  // Keyset seek: the order mixes DESC (priority_rank, severity, likelihood,
  // recency) with ASC (story_id), so a uniform row-value comparison does not
  // apply — the predicate is an expanded per-column lexicographic chain with
  // each column's own direction.
  let keyset = "";
  if (cursor) {
    const pr = p(cursor.pr);
    const ss = p(cursor.ss);
    const ls = p(cursor.ls);
    const rt = p(cursor.rt);
    const sid = p(cursor.sid);
    keyset =
      `WHERE (priority_rank < ${pr})\n` +
      `   OR (priority_rank = ${pr} AND severity_score < ${ss})\n` +
      `   OR (priority_rank = ${pr} AND severity_score = ${ss} AND likelihood_score < ${ls})\n` +
      `   OR (priority_rank = ${pr} AND severity_score = ${ss} AND likelihood_score = ${ls} AND recency_ts < ${rt}::timestamptz)\n` +
      `   OR (priority_rank = ${pr} AND severity_score = ${ss} AND likelihood_score = ${ls} AND recency_ts = ${rt}::timestamptz AND story_id > ${sid}::bigint)`;
  }

  // Fetch one extra row to detect whether a further page exists.
  const limit = p(pageSize + 1);

  const sql = `WITH base AS (
       SELECT story_id,
              priority_tier,
              severity_score,
              likelihood_score,
              status,
              COALESCE(last_ready_at, updated_at) AS recency_ts,
              ${rankCase} AS priority_rank
         FROM story_analysis_state
        WHERE ${baseConds.join("\n          AND ")}
     )
     SELECT story_id::text AS story_id,
            priority_tier,
            severity_score,
            likelihood_score,
            status,
            recency_ts::text AS recency_ts,
            priority_rank
       FROM base
     ${keyset}
      ORDER BY priority_rank DESC, severity_score DESC, likelihood_score DESC,
               recency_ts DESC, story_id ASC
      LIMIT ${limit}`;

  const result = await authPool.query<{
    story_id: string;
    priority_tier: PriorityTier;
    severity_score: number;
    likelihood_score: number;
    status: StoryListStatus;
    recency_ts: string;
    priority_rank: number;
  }>(sql, params);

  const rows = result.rows;
  const hasMore = rows.length > pageSize;
  const pageRows = hasMore ? rows.slice(0, pageSize) : rows;

  const items: StoryListItem[] = pageRows.map((r) => ({
    storyId: r.story_id,
    priorityTier: r.priority_tier,
    severityScore: r.severity_score,
    likelihoodScore: r.likelihood_score,
    status: r.status,
    recencyTs: new Date(r.recency_ts),
  }));

  let nextCursor: string | null = null;
  if (hasMore) {
    const last = pageRows[pageRows.length - 1];
    nextCursor = encodeCursor({
      pr: last.priority_rank,
      ss: last.severity_score,
      ls: last.likelihood_score,
      rt: last.recency_ts,
      sid: last.story_id,
      lb: since ? since.toISOString() : null,
    } satisfies StoryCursor);
  }

  return { items, nextCursor };
}
