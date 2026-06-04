// RFC 0003 P1a (#361) — Tier-1 IOC feed parse + import into
// `ioc_feed_snapshot` (shared auth DB).
//
// The parsers turn a feed's published file format into normalized
// indicator values; `importFeedSnapshot` replaces all rows for a source
// in one transaction (snapshot semantics) and stamps each row with the
// source/feed provenance so freshness is recordable. Tests and dev seed
// from the committed pinned fixtures in `./feeds` — NEVER from live
// feeds (RFC 0003 §"Testing"). The scheduled feed-refresh worker that
// fetches live feeds on a cadence is a separate follow-up.

import "server-only";

import { createHash } from "node:crypto";
import ipaddr from "ipaddr.js";
import type { Pool } from "pg";
import {
  NormalizationError,
  normalizeDomain,
  normalizeHash,
  normalizeIp,
  normalizeUrl,
} from "./normalization";
import type { EntityType, HitType } from "./types";

// ---------------------------------------------------------------------------
// Parsers (pure)
// ---------------------------------------------------------------------------

/** Strip blank lines and `#` comments, returning trimmed content lines. */
function contentLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
}

/**
 * abuse.ch Feodo Tracker IP blocklist (plain-text form): one IP per line,
 * `#` comment lines. Returns the raw IP strings (normalization happens at
 * import time).
 */
export function parseIpBlocklist(text: string): string[] {
  return contentLines(text);
}

/**
 * abuse.ch URLhaus CSV. Comment/header lines start with `#`; data rows are
 * quoted CSV `id,dateadded,url,url_status,...`. Returns the URL column.
 */
export function parseUrlhausCsv(text: string): string[] {
  const urls: string[] = [];
  for (const line of contentLines(text)) {
    const fields = splitCsv(line);
    if (fields.length < 3) continue;
    const url = fields[2];
    if (url) urls.push(url);
  }
  return urls;
}

/**
 * abuse.ch URLhaus "Collected Payloads" CSV — a separate URLhaus download
 * from the URL feed (`parseUrlhausCsv`). Comment/header lines start with `#`;
 * data rows are quoted CSV
 * `firstseen,urlhaus_link,filetype,md5_hash,sha256_hash,signature`. Returns
 * the MD5 and SHA-256 hash columns (non-empty ones), so a malware payload a
 * story observed by file hash matches the same known-bad artifact URLhaus
 * catalogs. Both digests are emitted; normalization at import distinguishes
 * MD5 (32 hex) from SHA-256 (64 hex).
 */
export function parseUrlhausPayloadsCsv(text: string): string[] {
  const hashes: string[] = [];
  for (const line of contentLines(text)) {
    const fields = splitCsv(line);
    if (fields.length < 5) continue;
    const md5 = fields[3];
    const sha256 = fields[4];
    if (md5) hashes.push(md5);
    if (sha256) hashes.push(sha256);
  }
  return hashes;
}

/**
 * The host of each URLhaus URL that is a DOMAIN (not a bare-IP host),
 * lowercased. URLhaus publishes full URLs, but a story member often carries
 * only a bare `host`/`dns_query` domain; emitting the URL's host as a
 * separate DOMAIN row lets such a member match the same malicious
 * infrastructure (the `abuse.ch/urlhaus` policy already declares `DOMAIN`).
 * Matching on the exact host (FQDN) — not the registered domain — keeps it
 * precise: `c2.evil.test` matches, a sibling `mail.evil.test` does not, so a
 * malicious URL on shared hosting cannot over-flag the whole apex. IP hosts
 * are skipped (the IP, if public, is covered by IP feeds).
 */
export function parseUrlhausHosts(urls: readonly string[]): string[] {
  const hosts: string[] = [];
  for (const url of urls) {
    let host: string;
    try {
      host = normalizeUrl(url).derived?.host ?? "";
    } catch {
      continue;
    }
    if (host.length === 0) continue;
    // Strip IPv6 brackets before the IP test (`[2001:db8::1]` → `2001:db8::1`).
    if (ipaddr.isValid(host.replace(/^\[|\]$/g, ""))) continue;
    hosts.push(host);
  }
  return hosts;
}

/**
 * Spamhaus DROP / EDROP. Lines are `<CIDR> ; <SBLref>` with `;`/`#`
 * comments. Returns the CIDR strings.
 */
export function parseSpamhausDrop(text: string): string[] {
  const cidrs: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith("#") || line.startsWith(";")) {
      continue;
    }
    // Drop a trailing `; SBL...` comment, then take the first token.
    const beforeComment = line.split(";")[0].trim();
    const token = beforeComment.split(/\s+/)[0];
    if (token.includes("/")) cidrs.push(token);
  }
  return cidrs;
}

/** Minimal CSV field splitter handling double-quoted fields. */
function splitCsv(line: string): string[] {
  const out: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      out.push(field);
      field = "";
    } else {
      field += ch;
    }
  }
  out.push(field);
  return out.map((f) => f.trim());
}

// ---------------------------------------------------------------------------
// Normalization of parsed values → snapshot rows
// ---------------------------------------------------------------------------

/** A single row to insert into `ioc_feed_snapshot`. */
export interface FeedSnapshotRow {
  matchValue?: string;
  cidr?: string;
  /**
   * Per-row entity type, overriding the import's default. Lets one source
   * (e.g. URLhaus) contribute rows of more than one entity type — its URLs
   * as `URL` and their hosts as `DOMAIN` — under a single `source_policy_id`.
   */
  entityType?: EntityType;
}

/**
 * Normalize a list of raw exact values to canonical `match_value`s for the
 * given entity type, dropping (and counting) any that fail normalization.
 */
export function normalizeExactValues(
  entityType: EntityType,
  values: readonly string[],
): { rows: FeedSnapshotRow[]; skipped: number } {
  const seen = new Set<string>();
  const rows: FeedSnapshotRow[] = [];
  let skipped = 0;
  for (const value of values) {
    try {
      const normalized = normalizeForEntity(entityType, value);
      if (seen.has(normalized)) continue;
      seen.add(normalized);
      rows.push({ matchValue: normalized });
    } catch (err) {
      if (err instanceof NormalizationError) {
        skipped += 1;
        continue;
      }
      throw err;
    }
  }
  return { rows, skipped };
}

function normalizeForEntity(entityType: EntityType, value: string): string {
  switch (entityType) {
    case "IP":
      return normalizeIp(value).value;
    case "DOMAIN":
      return normalizeDomain(value).value;
    case "URL":
      return normalizeUrl(value).value;
    case "HASH":
      return normalizeHash(value).value;
    default:
      throw new NormalizationError(`unsupported entity type: ${entityType}`);
  }
}

/** Validate + de-duplicate CIDR networks (Spamhaus range entries). */
export function normalizeCidrs(values: readonly string[]): {
  rows: FeedSnapshotRow[];
  skipped: number;
} {
  const seen = new Set<string>();
  const rows: FeedSnapshotRow[] = [];
  let skipped = 0;
  for (const value of values) {
    const trimmed = value.trim();
    if (!/^[0-9a-fA-F:.]+\/\d{1,3}$/.test(trimmed)) {
      skipped += 1;
      continue;
    }
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    rows.push({ cidr: trimmed });
  }
  return { rows, skipped };
}

// ---------------------------------------------------------------------------
// Import (DB)
// ---------------------------------------------------------------------------

export interface ImportFeedParams {
  sourcePolicyId: string;
  entityType: EntityType;
  /** Intrinsic match type — Tier-1 IOC feeds are `deterministic_ioc`. */
  hitType: HitType;
  classification?: string;
  confidence?: number;
  sourceVersion?: string;
  /** ISO timestamp of the snapshot's freshness (drives stale coverage). */
  sourceUpdatedAt?: string;
  rows: readonly FeedSnapshotRow[];
  /** Override the computed content hash (defaults to sha256 of sorted rows). */
  feedHash?: string;
}

/**
 * Replace the snapshot for one source in a single transaction: DELETE all
 * existing rows for the `source_policy_id`, then INSERT the new rows
 * stamped with the source/feed provenance. Returns the row count and the
 * feed hash actually stored (audit). Empty `rows` clears the source.
 */
export async function importFeedSnapshot(
  pool: Pool,
  params: ImportFeedParams,
): Promise<{ rowCount: number; feedHash: string }> {
  const feedHash = params.feedHash ?? computeFeedHash(params.rows);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `DELETE FROM ioc_feed_snapshot WHERE source_policy_id = $1`,
      [params.sourcePolicyId],
    );
    for (const row of params.rows) {
      await client.query(
        `INSERT INTO ioc_feed_snapshot
           (source_policy_id, entity_type, match_value, cidr, hit_type,
            classification, confidence, source_version, feed_hash,
            source_updated_at)
         VALUES ($1, $2, $3, $4::cidr, $5, $6, $7, $8, $9, $10::timestamptz)`,
        [
          params.sourcePolicyId,
          row.entityType ?? params.entityType,
          row.matchValue ?? null,
          row.cidr ?? null,
          params.hitType,
          params.classification ?? null,
          params.confidence ?? null,
          params.sourceVersion ?? null,
          feedHash,
          params.sourceUpdatedAt ?? null,
        ],
      );
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  return { rowCount: params.rows.length, feedHash };
}

/** Deterministic content hash of a snapshot's rows (sorted for stability). */
export function computeFeedHash(rows: readonly FeedSnapshotRow[]): string {
  const entries = rows
    .map((r) => r.matchValue ?? `cidr:${r.cidr}`)
    .sort()
    .join("\n");
  return createHash("sha256").update(entries).digest("hex");
}
