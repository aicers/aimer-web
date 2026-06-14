// RFC 0003 P1a (#361) — Tier-1 IOC feed parse + import into
// `ioc_feed_snapshot` (dedicated feed DB, #564).
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
import { canonicalizeContext, normalizeContext } from "./context-payload";
import type {
  CsvColumnParseConfig,
  FeedParseConfig,
  FeedParseKind,
  FeedSource,
  GenericListParseConfig,
  RawFeedPayload,
} from "./feed-source";
import {
  NormalizationError,
  normalizeDomain,
  normalizeHash,
  normalizeIp,
  normalizeUrl,
} from "./normalization";
import type { EnrichmentContextPayload, EntityType, HitType } from "./types";

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
 * Default comment-line prefixes across the Tier-1 feeds: `#` (abuse.ch) and
 * `;` (Spamhaus). Used by `generic-list` (when its config does not override
 * them) and by the validity checks (`hasFeedDataLines`) for the bespoke kinds.
 */
const DEFAULT_COMMENT_PREFIXES: readonly string[] = ["#", ";"];

/**
 * A feed body the configured parser cannot parse — distinct from the lenient
 * "silently drop an unrecognized line" path the bespoke parsers use. Raised by
 * `csv-column` when its config references a column the content does not provide
 * (a header name that is absent, or an index out of range): a misconfiguration
 * or upstream format drift must surface, never collapse to a silent 0 rows.
 * `isUnparseableFeedContent` treats it as unparseable; the import path lets it
 * propagate so a bad fetch/upload fails rather than clearing a good snapshot.
 */
export class FeedParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FeedParseError";
  }
}

/**
 * Refang a defanged indicator so it normalizes: `hxxp`→`http` (covering
 * `hxxps`→`https`), `[.]`/`(.)`→`.`, `[at]`→`@`. Case-insensitive on the
 * scheme/`at` tokens. Used by `generic-list` when `refang` is enabled (feeds
 * that publish defanged IOCs); off for plain lists (e.g. IP blocklists).
 */
export function refangIndicator(value: string): string {
  return value
    .replace(/hxxp/gi, "http")
    .replace(/\[\.\]|\(\.\)/g, ".")
    .replace(/\[at\]/gi, "@");
}

/**
 * `generic-list` (#593): one indicator per line, with blank/comment stripping
 * and optional refang. Generalizes `ip-blocklist` (express it as
 * `generic-list` with `entityType: "IP"`, refang off). Comment prefixes and
 * refang come from `config`; absent ⇒ defaults (`#`/`;` comments, refang off).
 * Returns the raw indicator strings (normalization happens at import time).
 */
export function parseGenericList(
  text: string,
  config?: GenericListParseConfig,
): string[] {
  const prefixes = config?.commentPrefixes ?? DEFAULT_COMMENT_PREFIXES;
  const refang = config?.refang ?? false;
  const out: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.length === 0 || isCommentLine(line, prefixes)) continue;
    out.push(refang ? refangIndicator(line) : line);
  }
  return out;
}

/** Whether `line` (already trimmed) starts with any non-empty comment prefix. */
function isCommentLine(line: string, prefixes: readonly string[]): boolean {
  return prefixes.some((p) => p.length > 0 && line.startsWith(p));
}

/**
 * `csv-column` (#593): extract indicator column(s) from a CSV by header name
 * or zero-based index, each with its own `entityType`. Honors a configurable
 * delimiter, header-row skip, and comment-prefix skip. Returns `{ entityType,
 * value }` pairs in row-then-column order (normalization happens at import).
 *
 * Validation (never a silent 0 rows): a configured header `name` that the
 * header row lacks, or an `index` beyond the row width, raises `FeedParseError`
 * — so a misconfiguration or upstream format drift surfaces instead of
 * quietly clearing the source.
 */
export function parseCsvColumns(
  text: string,
  config: CsvColumnParseConfig,
): { entityType: EntityType; value: string }[] {
  if (config.columns.length === 0) {
    throw new FeedParseError("csv-column: at least one column is required");
  }
  const delimiter = config.delimiter ?? ",";
  const usesNames = config.columns.some((c) => c.name !== undefined);

  // Keep only the non-blank, non-comment lines, in order.
  const lines: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.length === 0) continue;
    if (config.commentPrefix && line.startsWith(config.commentPrefix)) continue;
    lines.push(line);
  }
  // Genuinely empty / comment-only content legitimately clears the source.
  if (lines.length === 0) return [];

  // The first remaining line is the header iff names are used or a skip is
  // requested; either way it is consumed (never emitted as data).
  const hasHeader = usesNames || config.skipHeader === true;
  const headerFields = hasHeader ? splitCsv(lines[0], delimiter) : undefined;
  const dataStart = hasHeader ? 1 : 0;

  // Resolve each column to a concrete index up front, so a missing header name
  // / out-of-range index fails as a parse error rather than a silent skip.
  const refWidth = (headerFields ?? splitCsv(lines[0], delimiter)).length;
  const resolved = config.columns.map((col) => {
    if (col.name !== undefined) {
      const index = headerFields?.indexOf(col.name) ?? -1;
      if (index < 0) {
        throw new FeedParseError(`csv-column: header "${col.name}" not found`);
      }
      return { index, entityType: col.entityType };
    }
    if (col.index === undefined) {
      throw new FeedParseError("csv-column: a column needs a name or index");
    }
    if (col.index < 0 || col.index >= refWidth) {
      throw new FeedParseError(
        `csv-column: index ${col.index} out of range (width ${refWidth})`,
      );
    }
    return { index: col.index, entityType: col.entityType };
  });

  const out: { entityType: EntityType; value: string }[] = [];
  for (let i = dataStart; i < lines.length; i += 1) {
    const fields = splitCsv(lines[i], delimiter);
    for (const col of resolved) {
      const value = fields[col.index];
      if (value) out.push({ entityType: col.entityType, value });
    }
  }
  return out;
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

/**
 * Spamhaus DROP / DROPv6 as published over HTTP today: NDJSON — one JSON
 * object per line, e.g. `{"cidr":"1.2.3.0/24","sblid":"SBL123","rir":"arin"}`,
 * interleaved with metadata line(s) (`{"type":"metadata",...}`) and the odd
 * `;`/`#` comment line. Parse line-by-line, emit the `cidr` of each object
 * that has one, and skip everything else (metadata, comments, blank lines,
 * unparseable lines). Normalization (`normalizeCidrs`) happens at import.
 *
 * EDROP was merged into DROP in 2024, so only the DROP (`drop_v4`/`drop_v6`)
 * JSON feeds are fetched; there is no separate EDROP download.
 */
export function parseSpamhausDropNdjson(text: string): string[] {
  const cidrs: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith("#") || line.startsWith(";")) {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      "cidr" in parsed &&
      typeof (parsed as { cidr: unknown }).cidr === "string"
    ) {
      const cidr = (parsed as { cidr: string }).cidr.trim();
      if (cidr.includes("/")) cidrs.push(cidr);
    }
  }
  return cidrs;
}

/**
 * Minimal CSV field splitter handling double-quoted fields. `delimiter`
 * defaults to `,` (the bespoke abuse.ch parsers); `csv-column` can override it
 * for sources published with another separator.
 */
function splitCsv(line: string, delimiter = ","): string[] {
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
    } else if (ch === delimiter) {
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
  /**
   * Optional per-row report-level context (RFC 0003 F6, #594). A
   * context-bearing parser (vendor IOC repositories) attaches actor /
   * campaign / malware-family / report-link context to the row; bare feeds
   * and the existing parsers leave it absent, so the `context` column stays
   * NULL and `feed_hash` is unaffected.
   */
  context?: EnrichmentContextPayload;
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

/**
 * Validate, canonicalize, and de-duplicate CIDR networks (Spamhaus range
 * entries). Each value is parsed with `ipaddr.js` and reduced to its
 * canonical network address (host bits zeroed), so the stored string is
 * always a valid PostgreSQL `cidr`. A loose regex is not enough here: values
 * like `999.999.999.999/24`, `203.0.113.0/33`, or `203.0.113.1/24` (host
 * bits set) match a `[0-9a-fA-F:.]+/\d+` shape but are rejected by the
 * `$N::cidr` cast, surfacing as a 500 mid-import. Anything `ipaddr.js`
 * rejects is dropped (and counted) instead, so an unparseable upload is
 * caught up front rather than at the DB write.
 */
export function normalizeCidrs(values: readonly string[]): {
  rows: FeedSnapshotRow[];
  skipped: number;
} {
  const seen = new Set<string>();
  const rows: FeedSnapshotRow[] = [];
  let skipped = 0;
  for (const value of values) {
    const trimmed = value.trim();
    let cidr: string;
    try {
      const [addr, prefix] = ipaddr.parseCIDR(trimmed);
      const network =
        addr.kind() === "ipv4"
          ? ipaddr.IPv4.networkAddressFromCIDR(trimmed)
          : ipaddr.IPv6.networkAddressFromCIDR(trimmed);
      cidr = `${network.toString()}/${prefix}`;
    } catch {
      skipped += 1;
      continue;
    }
    if (seen.has(cidr)) continue;
    seen.add(cidr);
    rows.push({ cidr });
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
 * Map a `source_policy_id` to a stable signed 64-bit advisory-lock key.
 * Different sources get (effectively) distinct keys so they stay concurrent;
 * the same source always maps to the same key so its imports serialize.
 */
export function feedSourceLockKey(sourcePolicyId: string): string {
  const digest = createHash("sha256").update(sourcePolicyId).digest();
  // First 8 bytes → signed 64-bit, the domain of pg_advisory_xact_lock(bigint).
  return BigInt.asIntN(64, digest.readBigUInt64BE(0)).toString();
}

/**
 * Replace the snapshot for one source in a single transaction: DELETE all
 * existing rows for the `source_policy_id`, then INSERT the new rows
 * stamped with the source/feed provenance. Returns the row count and the
 * feed hash actually stored (audit). Empty `rows` clears the source.
 *
 * A source-scoped `pg_advisory_xact_lock` is taken FIRST, inside this same
 * transaction, so two concurrent imports of the SAME source serialize:
 * under READ COMMITTED their DELETE+INSERT pairs could otherwise interleave
 * and break the replace-not-append guarantee. Different sources lock on
 * different keys and stay concurrent.
 */
export async function importFeedSnapshot(
  pool: Pool,
  params: ImportFeedParams,
): Promise<{ rowCount: number; feedHash: string }> {
  const feedHash = params.feedHash ?? computeFeedHash(params.rows);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock($1)", [
      feedSourceLockKey(params.sourcePolicyId),
    ]);
    await client.query(
      `DELETE FROM ioc_feed_snapshot WHERE source_policy_id = $1`,
      [params.sourcePolicyId],
    );
    for (const row of params.rows) {
      // Same normalization the hash uses, so the persisted JSONB and the
      // hash always agree on which context properties exist (and an
      // all-`undefined` payload stores NULL, not a non-null `{}`).
      const context = row.context ? normalizeContext(row.context) : undefined;
      await client.query(
        `INSERT INTO ioc_feed_snapshot
           (source_policy_id, entity_type, match_value, cidr, hit_type,
            classification, confidence, context, source_version, feed_hash,
            source_updated_at)
         VALUES ($1, $2, $3, $4::cidr, $5, $6, $7, $8::jsonb, $9, $10,
                 $11::timestamptz)`,
        [
          params.sourcePolicyId,
          row.entityType ?? params.entityType,
          row.matchValue ?? null,
          row.cidr ?? null,
          params.hitType,
          params.classification ?? null,
          params.confidence ?? null,
          context ? JSON.stringify(context) : null,
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

// ---------------------------------------------------------------------------
// Common downstream: raw payload (from any FeedSource) → snapshot rows → DB
// ---------------------------------------------------------------------------

/**
 * Parse + normalize one raw feed payload's content into snapshot rows,
 * dispatching on its `parse` kind. This is the common downstream shared by
 * every `FeedSource` (fixture / upload / fetch): a source yields raw bytes,
 * this turns them into `ioc_feed_snapshot` rows uniformly.
 */
export function parseFeedContent(
  parse: FeedParseKind,
  entityType: EntityType,
  content: string,
  config?: FeedParseConfig,
): FeedSnapshotRow[] {
  switch (parse) {
    case "ip-blocklist":
      return normalizeExactValues(entityType, parseIpBlocklist(content)).rows;
    case "urlhaus-csv": {
      // URLhaus contributes both URL rows and the DOMAIN host of each URL,
      // under the one `abuse.ch/urlhaus` source, so a bare `host`/`dns_query`
      // domain member matches the same infrastructure (its policy already
      // declares `["URL", "DOMAIN"]`).
      const urls = parseUrlhausCsv(content);
      const urlRows = normalizeExactValues("URL", urls).rows;
      const domainRows = normalizeExactValues(
        "DOMAIN",
        parseUrlhausHosts(urls),
      ).rows.map((row) => ({ ...row, entityType: "DOMAIN" as EntityType }));
      return [...urlRows, ...domainRows];
    }
    case "urlhaus-payloads-csv":
      // URLhaus also publishes a Collected Payloads dump keyed by MD5/SHA-256
      // hash (a separate download from the URL feed), under its own
      // `abuse.ch/urlhaus-payloads` source so it does not clobber the URL/host
      // snapshot.
      return normalizeExactValues("HASH", parseUrlhausPayloadsCsv(content))
        .rows;
    case "spamhaus-drop":
      return normalizeCidrs(parseSpamhausDrop(content)).rows;
    case "spamhaus-drop-ndjson":
      return normalizeCidrs(parseSpamhausDropNdjson(content)).rows;
    case "generic-list": {
      const cfg = config?.kind === "generic-list" ? config : undefined;
      return normalizeExactValues(entityType, parseGenericList(content, cfg))
        .rows;
    }
    case "csv-column": {
      if (config?.kind !== "csv-column") {
        throw new FeedParseError(
          "csv-column parse requires a csv-column parseConfig",
        );
      }
      return csvColumnRows(parseCsvColumns(content, config));
    }
    default:
      throw new Error(`unknown parse kind: ${parse}`);
  }
}

/**
 * Normalize `csv-column`'s per-column `{ entityType, value }` extractions into
 * snapshot rows: group by entity type, run each group through the same
 * `normalizeExactValues` the bespoke parsers use, and stamp every row with its
 * column's `entityType` (so a multi-type CSV contributes more than one entity
 * type under one source, like URLhaus' URL+DOMAIN). Per-type de-duplication is
 * inherited from `normalizeExactValues`.
 */
function csvColumnRows(
  extracted: readonly { entityType: EntityType; value: string }[],
): FeedSnapshotRow[] {
  const byType = new Map<EntityType, string[]>();
  const order: EntityType[] = [];
  for (const { entityType, value } of extracted) {
    let values = byType.get(entityType);
    if (!values) {
      values = [];
      byType.set(entityType, values);
      order.push(entityType);
    }
    values.push(value);
  }
  const rows: FeedSnapshotRow[] = [];
  for (const entityType of order) {
    const values = byType.get(entityType) as string[];
    for (const row of normalizeExactValues(entityType, values).rows) {
      rows.push({ ...row, entityType });
    }
  }
  return rows;
}

/** Count the non-blank, non-comment lines in `content`. */
function countDataLines(
  content: string,
  commentPrefixes: readonly string[],
): number {
  let count = 0;
  for (const raw of content.split(/\r?\n/)) {
    const trimmed = raw.trim();
    if (trimmed.length > 0 && !isCommentLine(trimmed, commentPrefixes)) {
      count += 1;
    }
  }
  return count;
}

/**
 * Whether `content` has at least one non-blank, non-comment data line.
 * `commentPrefixes` defaults to `#` (abuse.ch) and `;` (Spamhaus); a caller
 * with a configured parser (`csv-column`) passes its own prefix so the check
 * agrees with the parser rather than hardcoding the Tier-1 conventions.
 */
export function hasFeedDataLines(
  content: string,
  commentPrefixes: readonly string[] = DEFAULT_COMMENT_PREFIXES,
): boolean {
  return countDataLines(content, commentPrefixes) > 0;
}

/**
 * The comment prefixes a parser treats as non-data, driven by its config:
 * `generic-list` uses its configured prefixes (default `#`/`;`); `csv-column`
 * uses its single configured `commentPrefix` (none ⇒ no comment lines); the
 * bespoke kinds keep the `#`/`;` default. So `hasFeedDataLines` agrees with the
 * parser instead of hardcoding `#`/`;`.
 */
function commentPrefixesFor(
  parse: FeedParseKind,
  config?: FeedParseConfig,
): readonly string[] {
  if (parse === "generic-list" && config?.kind === "generic-list") {
    return config.commentPrefixes ?? DEFAULT_COMMENT_PREFIXES;
  }
  if (parse === "csv-column" && config?.kind === "csv-column") {
    return config.commentPrefix ? [config.commentPrefix] : [];
  }
  return DEFAULT_COMMENT_PREFIXES;
}

/** Whether the parser consumes the first data line as a header (`csv-column`). */
function parserSkipsHeader(
  parse: FeedParseKind,
  config?: FeedParseConfig,
): boolean {
  return (
    parse === "csv-column" &&
    config?.kind === "csv-column" &&
    (config.skipHeader === true ||
      config.columns.some((c) => c.name !== undefined))
  );
}

/**
 * Whether parsed `content` is "unparseable": it carries data lines yet yields
 * zero rows. The per-kind parsers are intentionally lenient and silently drop
 * anything they do not recognize, so a structurally-wrong body — an upstream
 * HTML error/block page, or a format drift returned with a 200 — parses to
 * nothing. A configured parser whose config the content cannot satisfy (a
 * `csv-column` header name absent / index out of range) raises `FeedParseError`
 * and is likewise unparseable — that check runs even for a header-only body, so
 * a misconfigured source cannot pass validation here only to throw later in
 * `importRawFeedPayload()`. Genuinely empty / comment-only content is NOT
 * unparseable (it legitimately clears the source); for `csv-column` a
 * header-only body with a VALID config counts as empty too, since the header is
 * not a data line (the header subtraction is applied only after the parser has
 * accepted the config). The comment prefix is taken from the parser's config so
 * the data-line check agrees with the parser. Shared by the manual-upload
 * validation and the self-fetch engine so neither replaces a good snapshot with
 * junk.
 */
export function isUnparseableFeedContent(
  parse: FeedParseKind,
  entityType: EntityType,
  content: string,
  config?: FeedParseConfig,
): boolean {
  const prefixes = commentPrefixesFor(parse, config);
  const dataCount = countDataLines(content, prefixes);
  // Genuinely empty / comment-only content legitimately clears the source —
  // no need to parse.
  if (dataCount === 0) return false;
  // Otherwise always invoke the parser so a config the content cannot satisfy
  // (a `csv-column` header name absent / index out of range) surfaces as a
  // parse error here rather than slipping through as a silent clear. Header
  // subtraction happens AFTER the config is validated, below.
  let rows: FeedSnapshotRow[];
  try {
    rows = parseFeedContent(parse, entityType, content, config);
  } catch (err) {
    if (err instanceof FeedParseError) return true;
    throw err;
  }
  if (rows.length > 0) return false;
  // The parser accepted the config but produced no rows. For a header-aware
  // parser (`csv-column`) a lone header line is consumed, not data, so a
  // header-only body is a legitimate clear; any further line that parsed to
  // nothing is unparseable. For non-header parsers, zero rows from data lines
  // is unparseable.
  if (parserSkipsHeader(parse, config) && dataCount === 1) return false;
  return true;
}

/**
 * Import one raw feed payload: parse + normalize its content (per the
 * payload's `parse` kind), then replace the source's snapshot rows in
 * `ioc_feed_snapshot`. The provenance carries the freshness/version stamp.
 */
export async function importRawFeedPayload(
  pool: Pool,
  payload: RawFeedPayload,
): Promise<{ rowCount: number; feedHash: string }> {
  return importFeedSnapshot(pool, {
    sourcePolicyId: payload.sourcePolicyId,
    entityType: payload.entityType,
    hitType: payload.hitType,
    classification: payload.classification,
    sourceVersion: payload.provenance.sourceVersion,
    sourceUpdatedAt: payload.provenance.sourceUpdatedAt,
    rows: parseFeedContent(
      payload.parse,
      payload.entityType,
      payload.content,
      payload.parseConfig,
    ),
  });
}

/**
 * Drive a full import from any `FeedSource`: pull its raw payloads, then
 * parse/normalize/import each into `ioc_feed_snapshot`. The source decides
 * WHERE the bytes come from; this function is the shared pipeline for all
 * supply modes.
 */
export async function importFromFeedSource(
  pool: Pool,
  source: FeedSource,
): Promise<void> {
  const payloads = await source.loadPayloads();
  for (const payload of payloads) {
    await importRawFeedPayload(pool, payload);
  }
}

/**
 * Deterministic content hash of a snapshot's rows (sorted for stability).
 *
 * Context (RFC 0003 F6, #594) is folded into a row's hash entry ONLY when
 * that row carries it, appended after a NUL separator, so a context-less row
 * hashes byte-for-byte as it did before this change — the existing five
 * feeds keep their exact `feed_hash` (no spurious re-import). Context is
 * serialized with `canonicalizeContext` (sorted keys), not a bare
 * `JSON.stringify`, so the same context with a different key-insertion order
 * hashes identically and does not trigger a phantom re-import; a genuine
 * context change does change the hash and re-imports.
 */
export function computeFeedHash(rows: readonly FeedSnapshotRow[]): string {
  const entries = rows
    .map((r) => {
      const base = r.matchValue ?? `cidr:${r.cidr}`;
      const ctx = r.context ? normalizeContext(r.context) : undefined;
      return ctx ? `${base}\0${canonicalizeContext(ctx)}` : base;
    })
    .sort()
    .join("\n");
  return createHash("sha256").update(entries).digest("hex");
}
