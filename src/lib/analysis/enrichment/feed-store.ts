// RFC 0003 P1a (#361) — pg-backed `FeedStore` over `ioc_feed_snapshot`
// (dedicated feed DB, #564).
//
// `probe` reports a source's snapshot provenance/freshness (so the
// enricher can emit answered/stale outcomes), and `match` returns the
// matching rows for one indicator within one source's snapshot. Exact
// matches test the indicator's candidate values; IP indicators also test
// CIDR containment (Spamhaus DROP/EDROP range entries) with `>>=`.

import "server-only";

import type { Pool } from "pg";
import { narrowContextPayload } from "./context-payload";
import { selfFetchModeActive } from "./feed-fetch";
import {
  candidateValues,
  type FeedMatchRow,
  type FeedSnapshotMeta,
  type FeedStore,
} from "./local-feed-enricher";
import type { HitType, NormalizedIndicator } from "./types";

function toIso(value: Date | string | null | undefined): string | undefined {
  if (value == null) return undefined;
  return value instanceof Date ? value.toISOString() : value;
}

export class PgFeedStore implements FeedStore {
  constructor(private readonly pool: Pool) {}

  async probe(sourcePolicyId: string): Promise<FeedSnapshotMeta> {
    // Self-fetch breaks the row-count probe: a 304-revalidated feed would
    // drift stale and a legitimately-empty (0-row) feed would read as
    // absent. So ONLY when self-fetch is the active mode AND a fetch-state
    // row exists, `feed_fetch_state` is the presence/freshness authority
    // (success — incl. 0 rows — = present; fresh = `last_fetched_at`),
    // independent of snapshot row count. The active-mode gate keeps a stale
    // `feed_fetch_state` row from a prior self-fetch deployment from leaking
    // into a later manual-upload probe.
    if (selfFetchModeActive()) {
      const selfFetch = await this.probeSelfFetch(sourcePolicyId);
      if (selfFetch) return selfFetch;
    }

    const { rows } = await this.pool.query<{
      cnt: string;
      source_version: string | null;
      feed_hash: string | null;
      source_updated_at: Date | null;
    }>(
      `SELECT COUNT(*)::text          AS cnt,
              MAX(source_version)      AS source_version,
              MAX(feed_hash)           AS feed_hash,
              MAX(source_updated_at)   AS source_updated_at
         FROM ioc_feed_snapshot
        WHERE source_policy_id = $1`,
      [sourcePolicyId],
    );
    const row = rows[0];
    const present = row !== undefined && Number(row.cnt) > 0;
    if (!present) return { present: false };
    return {
      present: true,
      sourceVersion: row.source_version ?? undefined,
      feedHash: row.feed_hash ?? undefined,
      sourceUpdatedAt: toIso(row.source_updated_at),
    };
  }

  /**
   * Self-fetch presence/freshness from `feed_fetch_state`. Returns `null`
   * when no fetch-state row exists (caller falls back to the row-count probe
   * — e.g. a source that has never been fetched). A row with a successful
   * fetch (`last_fetched_at` set, by a 200 or 304) is `present` regardless of
   * snapshot row count; `sourceUpdatedAt` is `last_fetched_at`. A row that has
   * only ever failed (no `last_fetched_at`) is `present: false`.
   */
  private async probeSelfFetch(
    sourcePolicyId: string,
  ): Promise<FeedSnapshotMeta | null> {
    const { rows } = await this.pool.query<{
      last_fetched_at: Date | null;
      source_version: string | null;
      feed_hash: string | null;
    }>(
      `SELECT s.last_fetched_at,
              snap.source_version,
              snap.feed_hash
         FROM feed_fetch_state s
         LEFT JOIN LATERAL (
           SELECT MAX(source_version) AS source_version,
                  MAX(feed_hash)       AS feed_hash
             FROM ioc_feed_snapshot
            WHERE source_policy_id = s.source_policy_id
         ) snap ON TRUE
        WHERE s.source_policy_id = $1`,
      [sourcePolicyId],
    );
    const row = rows[0];
    if (!row) return null;
    if (row.last_fetched_at == null) return { present: false };
    return {
      present: true,
      sourceVersion: row.source_version ?? undefined,
      feedHash: row.feed_hash ?? undefined,
      sourceUpdatedAt: toIso(row.last_fetched_at),
    };
  }

  async match(
    sourcePolicyId: string,
    indicator: NormalizedIndicator,
  ): Promise<FeedMatchRow[]> {
    const candidates = candidateValues(indicator);
    // Exact matches across the indicator's candidate values. `match_value`
    // holds the normalized indicator, so matching by value (rather than
    // entity_type) lets a URL indicator also hit a feed's host/domain
    // entry via its derived candidates.
    const exact = await this.pool.query<{
      hit_type: HitType | null;
      classification: string | null;
      confidence: number | null;
      context: unknown;
      source_version: string | null;
      feed_hash: string | null;
      source_updated_at: Date | null;
    }>(
      `SELECT hit_type, classification, confidence, context,
              source_version, feed_hash, source_updated_at
         FROM ioc_feed_snapshot
        WHERE source_policy_id = $1
          AND match_value = ANY($2::text[])`,
      [sourcePolicyId, candidates],
    );
    const rows = exact.rows;

    // CIDR containment — IP indicators only (Spamhaus-style range feeds).
    if (indicator.entityType === "IP") {
      const range = await this.pool.query<{
        hit_type: HitType;
        classification: string | null;
        confidence: number | null;
        context: unknown;
        source_version: string | null;
        feed_hash: string | null;
        source_updated_at: Date | null;
      }>(
        `SELECT hit_type, classification, confidence, context,
                source_version, feed_hash, source_updated_at
           FROM ioc_feed_snapshot
          WHERE source_policy_id = $1
            AND cidr IS NOT NULL
            AND cidr >>= $2::inet`,
        [sourcePolicyId, indicator.value],
      );
      rows.push(...range.rows);
    }

    return rows.map((row) => ({
      // NULL for a negative (warninglist) row (#599); the negative enricher
      // branch ignores it and the positive branch requires it.
      hitType: row.hit_type ?? undefined,
      classification: row.classification ?? undefined,
      confidence: row.confidence ?? undefined,
      // The `context` JSONB is `unknown` at runtime — narrow it through the
      // validator before it reaches the match; never trust the pg row as-is.
      contextPayload: narrowContextPayload(row.context),
      sourceVersion: row.source_version ?? undefined,
      feedHash: row.feed_hash ?? undefined,
      sourceUpdatedAt: toIso(row.source_updated_at),
    }));
  }
}
