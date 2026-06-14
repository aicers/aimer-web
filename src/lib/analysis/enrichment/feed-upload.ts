// RFC 0003 Tier-1 feed-refresh (#566) — manual-upload supply mode helpers.
//
// A System Admin uploads a Tier-1 feed file through the admin UI; the upload
// route builds a `RawFeedPayload` from the shared catalog + upload provenance
// and imports it via the common downstream (`importRawFeedPayload`). No
// outbound fetch — this is the air-gapped / closed-network supply mode.
//
// These helpers are pure (no request/response coupling) so the route stays
// thin and the validation rules are unit-testable.

import "server-only";

import type { Pool } from "pg";
import { getTier1FeedSource, TIER1_FEED_SOURCES } from "./feed-catalog";
import { hasFeedDataLines, isUnparseableFeedContent } from "./feed-import";
import { type RawFeedPayload, resolveTiFeedMode } from "./feed-source";

// Re-exported from the shared parse module (`feed-import`) where the rule now
// lives, so manual-upload and self-fetch validate feed content identically.
export { hasFeedDataLines };

/** Sane upper bound on an uploaded feed file (Tier-1 feeds are modest). */
export const MAX_FEED_UPLOAD_BYTES = 32 * 1024 * 1024; // 32 MiB

/** A user-facing, 400-worthy upload validation failure. */
export class FeedUploadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FeedUploadError";
  }
}

/**
 * Whether `manual-upload` is the active supply mode (`TI_FEED_MODE`). A
 * reserved-but-unimplemented mode (`self-fetch` / `managed`) makes
 * `resolveTiFeedMode` throw — treated here as "not active" so the upload
 * route/UI is inactive (404) outside `manual-upload`.
 */
export function manualUploadModeActive(
  value: string | undefined = process.env.TI_FEED_MODE,
): boolean {
  try {
    return resolveTiFeedMode(value) === "manual-upload";
  } catch {
    return false;
  }
}

/**
 * Build a `manual-upload` `RawFeedPayload`: catalog-derived parse fields +
 * the uploaded bytes + upload provenance. Throws `FeedUploadError` when the
 * source is not in the catalog.
 */
export function buildManualUploadPayload(args: {
  sourcePolicyId: string;
  filename: string;
  content: string;
  uploadedAt: string;
}): RawFeedPayload {
  const source = getTier1FeedSource(args.sourcePolicyId);
  if (!source) {
    throw new FeedUploadError(`Unknown source: ${args.sourcePolicyId}`);
  }
  return {
    sourcePolicyId: source.sourcePolicyId,
    parse: source.parse,
    entityType: source.entityType,
    polarity: source.polarity,
    hitType: source.hitType,
    classification: source.classification,
    content: args.content,
    provenance: {
      mode: "manual-upload",
      origin: `manual-upload:${args.filename}`,
      sourceUpdatedAt: args.uploadedAt,
    },
  };
}

/**
 * Reject content that has data lines yet parses to zero rows ("unparseable":
 * a structurally-wrong file the lenient per-kind parsers silently drop).
 * Genuinely empty / comment-only content is allowed — it clears the source.
 */
export function assertParseableUpload(payload: RawFeedPayload): void {
  if (
    isUnparseableFeedContent(payload.parse, payload.entityType, payload.content)
  ) {
    throw new FeedUploadError(
      "Uploaded file has no recognizable feed entries for this source",
    );
  }
}

/** Per-source status for the admin UI, derived from `ioc_feed_snapshot`. */
export interface FeedSourceStatus {
  sourcePolicyId: string;
  label: string;
  /** `false` when no snapshot rows exist (never uploaded, or cleared). */
  present: boolean;
  rowCount: number;
  sourceUpdatedAt: string | null;
  feedHash: string | null;
  /** Derived from the source's `maxAge`: `now - sourceUpdatedAt > maxAge`. */
  stale: boolean;
}

function toIso(value: Date | string | null | undefined): string | null {
  if (value == null) return null;
  return value instanceof Date ? value.toISOString() : String(value);
}

/**
 * Per-source status for every catalog source, aggregated from
 * `ioc_feed_snapshot` (group by `source_policy_id`). A source with no rows
 * reports `present: false` — a cleared source looks identical to a
 * never-uploaded one (status is derived purely from the snapshot table).
 */
export async function getFeedSourceStatuses(
  pool: Pool,
  now: Date,
): Promise<FeedSourceStatus[]> {
  const { rows } = await pool.query<{
    source_policy_id: string;
    row_count: string;
    source_updated_at: Date | null;
    feed_hash: string | null;
  }>(
    `SELECT source_policy_id,
            COUNT(*)::text         AS row_count,
            MAX(source_updated_at) AS source_updated_at,
            MAX(feed_hash)         AS feed_hash
       FROM ioc_feed_snapshot
      GROUP BY source_policy_id`,
  );
  const byId = new Map(rows.map((r) => [r.source_policy_id, r]));

  return TIER1_FEED_SOURCES.map((source) => {
    const row = byId.get(source.sourcePolicyId);
    const rowCount = row ? Number(row.row_count) : 0;
    const present = rowCount > 0;
    const sourceUpdatedAt = present ? toIso(row?.source_updated_at) : null;
    const stale =
      present && sourceUpdatedAt !== null
        ? now.getTime() - new Date(sourceUpdatedAt).getTime() > source.maxAge
        : false;
    return {
      sourcePolicyId: source.sourcePolicyId,
      label: source.label,
      present,
      rowCount,
      sourceUpdatedAt,
      feedHash: present ? (row?.feed_hash ?? null) : null,
      stale,
    };
  });
}
