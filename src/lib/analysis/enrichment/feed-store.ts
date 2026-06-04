// RFC 0003 P1a (#361) — pg-backed `FeedStore` over `ioc_feed_snapshot`
// (shared auth DB).
//
// `probe` reports a source's snapshot provenance/freshness (so the
// enricher can emit answered/stale outcomes), and `match` returns the
// matching rows for one indicator within one source's snapshot. Exact
// matches test the indicator's candidate values; IP indicators also test
// CIDR containment (Spamhaus DROP/EDROP range entries) with `>>=`.

import "server-only";

import type { Pool } from "pg";
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
      hit_type: HitType;
      classification: string | null;
      confidence: number | null;
      source_version: string | null;
      feed_hash: string | null;
      source_updated_at: Date | null;
    }>(
      `SELECT hit_type, classification, confidence,
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
        source_version: string | null;
        feed_hash: string | null;
        source_updated_at: Date | null;
      }>(
        `SELECT hit_type, classification, confidence,
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
      hitType: row.hit_type,
      classification: row.classification ?? undefined,
      confidence: row.confidence ?? undefined,
      sourceVersion: row.source_version ?? undefined,
      feedHash: row.feed_hash ?? undefined,
      sourceUpdatedAt: toIso(row.source_updated_at),
    }));
  }
}
