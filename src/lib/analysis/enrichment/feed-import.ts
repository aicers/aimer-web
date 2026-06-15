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
import type { Pool, PoolClient } from "pg";
import { canonicalizeContext, normalizeContext } from "./context-payload";
import type {
  CsvColumnParseConfig,
  FeedParseConfig,
  FeedParseKind,
  FeedSource,
  FreeTextParseConfig,
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
import type {
  EnrichmentContextPayload,
  EntityType,
  HitType,
  SourcePolarity,
} from "./types";

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
 * Whether a `csv-column` config uses the row-typed (`typeColumn`) extraction
 * mode (#605) rather than the static per-column (`columns`) mode. Exactly one
 * of the two must be present.
 */
function isRowTypedCsv(config: CsvColumnParseConfig): boolean {
  return config.typeColumn !== undefined;
}

/** Whether any column reference in a `csv-column` config selects by header name. */
function csvConfigUsesNames(config: CsvColumnParseConfig): boolean {
  if (config.typeColumn) {
    const { value, type } = config.typeColumn;
    if (value.name !== undefined || type.name !== undefined) return true;
    return config.rowFilter?.column.name !== undefined;
  }
  if (config.shapeColumn) {
    if (config.shapeColumn.value.name !== undefined) return true;
    return config.rowFilter?.column.name !== undefined;
  }
  return (config.columns ?? []).some((c) => c.name !== undefined);
}

/**
 * Resolve one `CsvColumnRef` to a concrete column index against the header
 * (when selecting by name) or the row width (when selecting by index). A
 * missing header name / out-of-range index raises `FeedParseError` so a
 * misconfiguration or upstream format drift surfaces instead of a silent skip.
 */
function resolveCsvRef(
  ref: { name?: string; index?: number },
  headerFields: string[] | undefined,
  refWidth: number,
): number {
  if (ref.name !== undefined) {
    const index = headerFields?.indexOf(ref.name) ?? -1;
    if (index < 0) {
      throw new FeedParseError(`csv-column: header "${ref.name}" not found`);
    }
    return index;
  }
  if (ref.index === undefined) {
    throw new FeedParseError("csv-column: a column needs a name or index");
  }
  if (ref.index < 0 || ref.index >= refWidth) {
    throw new FeedParseError(
      `csv-column: index ${ref.index} out of range (width ${refWidth})`,
    );
  }
  return ref.index;
}

/**
 * Lowercased tokens that are file extensions, not TLDs — so the domain scanner
 * does not read `payload.exe` / `gate.php` / `analysis.md` as a DOMAIN. A bare
 * dotted token whose last label is one of these is dropped before normalization.
 *
 * Deliberately excludes `com`: although `.COM` is a legacy DOS executable
 * extension, `.com` is by far the most common real-world TLD, so dropping every
 * `c2[.]evil[.]com`-style prose IOC to catch a rare `command.com` reference is
 * the wrong trade — `normalizeDomain` remains the final arbiter for the rare
 * collision.
 */
const FILE_EXTENSION_TOKENS: ReadonlySet<string> = new Set([
  "exe",
  "dll",
  "bin",
  "dat",
  "sys",
  "scr",
  "msi",
  "dmg",
  "iso",
  "img",
  "php",
  "html",
  "htm",
  "asp",
  "aspx",
  "jsp",
  "cgi",
  "js",
  "css",
  "json",
  "xml",
  "yml",
  "yaml",
  "md",
  "txt",
  "log",
  "csv",
  "tsv",
  "ini",
  "cfg",
  "conf",
  "toml",
  "png",
  "jpg",
  "jpeg",
  "gif",
  "bmp",
  "svg",
  "ico",
  "webp",
  "pdf",
  "doc",
  "docx",
  "xls",
  "xlsx",
  "ppt",
  "pptx",
  "rtf",
  "zip",
  "rar",
  "gz",
  "tar",
  "7z",
  "bz2",
  "sh",
  "bat",
  "ps1",
  "vbs",
  "py",
  "rb",
  "pl",
  "go",
  "rs",
  "c",
  "cpp",
  "h",
  "sql",
  "db",
  "bak",
  "tmp",
  "lnk",
  "jar",
  "apk",
  "deb",
  "rpm",
  "sig",
  "yar",
  "yara",
  "rules",
  "ioc",
  "stix",
]);

/**
 * Free-text atomic IOC scanner (#603): pull IP / DOMAIN / URL / HASH indicators
 * embedded in PROSE (vendor-repo blog notes, READMEs), where `generic-list` —
 * one line equals one indicator — cannot reach an IOC inside a sentence. The
 * whole body is refanged (on by default), then scanned strongest-shape-first
 * (URLs, then hashes, then IPv4, then domains), masking each match out so a
 * domain inside an already-extracted URL is not double-counted. Returns
 * `{ entityType, value }` pairs (each token self-classifies its type);
 * normalization + de-duplication happen at import (`freeTextRows`). Tolerates a
 * body with zero IOCs (returns `[]`) — low-yield notes are not an error.
 */
export function parseFreeTextIocs(
  text: string,
  config?: FreeTextParseConfig,
): { entityType: EntityType; value: string }[] {
  const refang = config?.refang ?? true;
  // Optional positive line-allowlist (#628): keep only lines whose raw text
  // matches `keepLinePattern`, then scan those. Applied BEFORE refang so the
  // pattern matches the original type-column tag. Absent ⇒ keep every line.
  const kept =
    config?.keepLinePattern === undefined
      ? text
      : ((): string => {
          const keepRe = new RegExp(config.keepLinePattern);
          return text
            .split(/\r?\n/)
            .filter((line) => keepRe.test(line))
            .join("\n");
        })();
  let work = refang ? refangIndicator(kept) : kept;
  const out: { entityType: EntityType; value: string }[] = [];
  const seen = new Set<string>();
  const push = (entityType: EntityType, raw: string): void => {
    const value = raw.replace(/[.,;:!?'")\]}>]+$/, "");
    if (value.length === 0) return;
    const key = `${entityType}\0${value.toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ entityType, value });
  };

  // 1. URLs — captured whole, then masked so their host/path is not re-scanned.
  const urlRe = /\bhttps?:\/\/[^\s<>"'`()[\]{}]+/gi;
  for (const m of work.matchAll(urlRe)) push("URL", m[0]);
  work = work.replace(urlRe, " ");

  // 2. Hashes — longest shape first (SHA-256, SHA-1, MD5) so a 64-hex string is
  //    not split into shorter hex runs.
  for (const len of [64, 40, 32]) {
    const hashRe = new RegExp(`\\b[a-fA-F0-9]{${len}}\\b`, "g");
    for (const m of work.matchAll(hashRe)) push("HASH", m[0]);
    work = work.replace(hashRe, " ");
  }

  // 3. IPv4 dotted-quad.
  const ipRe = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;
  for (const m of work.matchAll(ipRe)) push("IP", m[0]);
  work = work.replace(ipRe, " ");

  // 4. Domains — a dotted token whose last label is alphabetic (2-24 chars) and
  //    is not a file extension. Normalization (`normalizeDomain`) is the final
  //    arbiter; this only keeps the false-positive rate sane over prose.
  const domainRe =
    /\b(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,24}\b/g;
  for (const m of work.matchAll(domainRe)) {
    const value = m[0];
    const tld = value.slice(value.lastIndexOf(".") + 1).toLowerCase();
    if (FILE_EXTENSION_TOKENS.has(tld)) continue;
    push("DOMAIN", value);
  }
  return out;
}

/**
 * `csv-column` (#593, generalized #605, #625): extract indicator column(s)
 * from a CSV. Three modes (mutually exclusive, see `CsvColumnParseConfig`):
 * static per-column (`columns`, each with its own `entityType`), row-typed
 * (`typeColumn`, one value column whose entity type comes from a per-row
 * `type` column via `typeMap`), and shape-classified (`shapeColumn`, one value
 * column whose entity type is derived per cell from the value shape via the
 * free-text scanner — packed-hash cells split per hash). Honors a configurable
 * delimiter, header-row
 * skip, comment-prefix skip, an optional `rowFilter` allowlist on another
 * column, and `refang` of extracted values. A leading UTF-8 BOM on the first
 * line is stripped (some Infoblox files are BOM-prefixed). Returns
 * `{ entityType, value }` pairs in row-then-column order (normalization
 * happens at import).
 *
 * Validation (never a silent 0 rows): a configured header `name` that the
 * header row lacks, or an `index` beyond the row width, raises `FeedParseError`
 * — so a misconfiguration or upstream format drift surfaces instead of quietly
 * clearing the source. A row whose `type` is unmapped, or that the `rowFilter`
 * drops, is a silent per-row skip (expected, not an error).
 */
export function parseCsvColumns(
  text: string,
  config: CsvColumnParseConfig,
): { entityType: EntityType; value: string }[] {
  const rowTyped = isRowTypedCsv(config);
  const shaped = config.shapeColumn !== undefined;
  const staticCols = (config.columns ?? []).length > 0;
  const modeCount =
    (staticCols ? 1 : 0) + (rowTyped ? 1 : 0) + (shaped ? 1 : 0);
  if (modeCount > 1) {
    throw new FeedParseError(
      "csv-column: `columns`, `typeColumn`, and `shapeColumn` are " +
        "mutually exclusive",
    );
  }
  if (modeCount === 0) {
    throw new FeedParseError(
      "csv-column: one of `columns` / `typeColumn` / `shapeColumn` is required",
    );
  }
  const delimiter = config.delimiter ?? ",";
  const refang = config.refang ?? false;
  const usesNames = csvConfigUsesNames(config);

  // Strip a leading UTF-8 BOM so a header-name lookup (`indexOf("type")`)
  // resolves on BOM-prefixed files, then keep only non-blank, non-comment
  // lines in order.
  const lines: string[] = [];
  for (const raw of text.replace(/^\uFEFF/, "").split(/\r?\n/)) {
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
  const refWidth = (headerFields ?? splitCsv(lines[0], delimiter)).length;

  const emit = refang
    ? (value: string): string => refangIndicator(value)
    : (value: string): string => value;

  // The optional row allowlist filter resolves to a column index + a set.
  const filterIndex = config.rowFilter
    ? resolveCsvRef(config.rowFilter.column, headerFields, refWidth)
    : -1;
  const allow = config.rowFilter ? new Set(config.rowFilter.allow) : undefined;
  const passesFilter = (fields: string[]): boolean => {
    if (!allow) return true;
    const v = fields[filterIndex];
    return v !== undefined && allow.has(v);
  };

  const out: { entityType: EntityType; value: string }[] = [];

  if (rowTyped) {
    const tc = config.typeColumn as NonNullable<
      CsvColumnParseConfig["typeColumn"]
    >;
    const valueIndex = resolveCsvRef(tc.value, headerFields, refWidth);
    const typeIndex = resolveCsvRef(tc.type, headerFields, refWidth);
    for (let i = dataStart; i < lines.length; i += 1) {
      const fields = splitCsv(lines[i], delimiter);
      if (!passesFilter(fields)) continue;
      const typeValue = fields[typeIndex];
      if (!typeValue) continue;
      // Unmapped type (e.g. `email`, `telfhash`, future drift) → skip, not error.
      const entityType = tc.typeMap[typeValue];
      if (!entityType) continue;
      const value = fields[valueIndex];
      if (value) out.push({ entityType, value: emit(value) });
    }
    return out;
  }

  if (shaped) {
    const sc = config.shapeColumn as NonNullable<
      CsvColumnParseConfig["shapeColumn"]
    >;
    const valueIndex = resolveCsvRef(sc.value, headerFields, refWidth);
    // Vendor value cells are defanged prose by convention, so refang defaults
    // ON here (unlike the `columns` / `typeColumn` modes) — `hxxp://` must
    // refang before the URL shape can classify.
    const cellConfig: FreeTextParseConfig = {
      kind: "free-text",
      refang: config.refang ?? true,
    };
    for (let i = dataStart; i < lines.length; i += 1) {
      const fields = splitCsv(lines[i], delimiter);
      if (!passesFilter(fields)) continue;
      const cell = fields[valueIndex];
      if (!cell) continue;
      // Scan ONLY the isolated value cell — never the whole line — so the
      // free-text scanner's interior-comma URL bug and its sibling-column
      // (description/notes) false positives can NEVER fire. A `file` cell
      // packing 2-3 hashes splits into per-hash rows; a cell of no recognized
      // shape yields nothing (a silent per-row skip).
      out.push(...parseFreeTextIocs(cell, cellConfig));
    }
    return out;
  }

  // Static per-column mode: resolve each column to a concrete index up front.
  const resolved = (config.columns ?? []).map((col) => ({
    index: resolveCsvRef(col, headerFields, refWidth),
    entityType: col.entityType,
  }));
  for (let i = dataStart; i < lines.length; i += 1) {
    const fields = splitCsv(lines[i], delimiter);
    if (!passesFilter(fields)) continue;
    for (const col of resolved) {
      const value = fields[col.index];
      if (value) out.push({ entityType: col.entityType, value: emit(value) });
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
    hashes.push(...parseUrlhausPayloadsCsvLine(line));
  }
  return hashes;
}

/**
 * One data row of the URLhaus Collected Payloads CSV → its non-empty MD5
 * (index 3) and SHA-256 (index 4) hash columns. The single-line analogue of
 * `parseUrlhausPayloadsCsv`, for the streaming self-fetch path that line-parses
 * the decompressed CSV instead of buffering the whole ~2.6 GB body. A
 * blank/comment/short row yields `[]`; the caller skips blank/comment lines
 * before calling this.
 */
export function parseUrlhausPayloadsCsvLine(line: string): string[] {
  const fields = splitCsv(line);
  if (fields.length < 5) return [];
  const out: string[] = [];
  if (fields[3]) out.push(fields[3]);
  if (fields[4]) out.push(fields[4]);
  return out;
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
 * One MISP warninglist as published upstream at `lists/<name>/list.json`
 * (RFC 0003 F5, #615): a `type` (matching semantics) + a `list` of entries,
 * plus a human-readable `name`. Only the fields the parser reads are typed; the
 * rest (`version`, `description`, `matching_attributes`) are ignored.
 */
interface MispWarninglist {
  /** Human-readable list name, carried per-row into `classification`. */
  name?: string;
  /** Matching semantics: `string` | `substring` | `hostname` | `cidr` | `regex`. */
  type: string;
  /** The list entries (IP / CIDR / hostname strings). */
  list: unknown[];
}

/**
 * MISP warninglists negative-layer parser (RFC 0003 F5, #615). The first
 * `polarity: "negative"` source's bespoke parser: it never emits a positive
 * match, only suppression rows that down-weight likely false positives (public
 * DNS resolvers, CDN/cloud ranges, bogons).
 *
 * `content` is a JSON ARRAY of `list.json` objects (a single-element array is
 * the degenerate one-list case); every list is flattened into ONE row set so a
 * multi-list payload lands in one snapshot replace (no last-file-wins clobber).
 * Each list branches on `type`:
 *
 *   - `cidr` → a normalized cidr row per valid CIDR entry.
 *   - `string` / `hostname` → an exact IP `matchValue` row per entry that
 *     normalizes to an IP (v1 is IP-only; a non-IP entry is skipped silently).
 *   - `substring` / `regex` / any unknown `type` → the whole list is skipped
 *     silently (the store has no such match path) — never an error, so an
 *     unsupported list can never break import.
 *
 * Every emitted row carries its source list's `name` as `classification`, so a
 * suppression decision can name WHICH warninglist matched.
 *
 * Skips are for recognized-but-unsupported shapes only. MALFORMED input is a
 * `FeedParseError`: invalid JSON, a non-array top level, a list element that is
 * not an object or is missing a string `type` / array `list`. (Per-entry
 * CIDR/value validity follows the existing parsers' silent-drop convention.)
 */
export function parseMispWarninglists(content: string): FeedSnapshotRow[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new FeedParseError("misp-warninglist: content is not valid JSON");
  }
  if (!Array.isArray(parsed)) {
    throw new FeedParseError(
      "misp-warninglist: top-level value must be a JSON array of lists",
    );
  }
  const rows: FeedSnapshotRow[] = [];
  for (const element of parsed) {
    const list = asWarninglist(element);
    const entries = list.list.filter(
      (entry): entry is string => typeof entry === "string",
    );
    let listRows: FeedSnapshotRow[];
    if (list.type === "cidr") {
      listRows = normalizeCidrs(entries).rows;
    } else if (list.type === "string" || list.type === "hostname") {
      // v1 is IP-only: a non-IP entry fails normalization and is skipped.
      listRows = normalizeExactValues("IP", entries).rows;
    } else {
      // `substring` / `regex` / unknown type → no store match path; skip the
      // whole list silently (never an error).
      continue;
    }
    // Stamp each row with its source list's `name` so the suppression surface
    // (#591) can show which warninglist suppressed the indicator.
    for (const row of listRows) {
      rows.push(
        list.name !== undefined ? { ...row, classification: list.name } : row,
      );
    }
  }
  return rows;
}

/**
 * Narrow one decoded JSON-array element to a `MispWarninglist`, raising
 * `FeedParseError` on a malformed element (not an object, or missing a string
 * `type` / array `list`). Malformed structure must surface — only a
 * recognized-but-unsupported `type` is a silent skip (handled by the caller).
 */
function asWarninglist(element: unknown): MispWarninglist {
  if (
    element === null ||
    typeof element !== "object" ||
    Array.isArray(element)
  ) {
    throw new FeedParseError(
      "misp-warninglist: each list element must be a JSON object",
    );
  }
  const obj = element as Record<string, unknown>;
  if (typeof obj.type !== "string") {
    throw new FeedParseError(
      "misp-warninglist: a list element is missing a string `type`",
    );
  }
  if (!Array.isArray(obj.list)) {
    throw new FeedParseError(
      "misp-warninglist: a list element's `list` must be an array",
    );
  }
  return {
    name: typeof obj.name === "string" ? obj.name : undefined,
    type: obj.type,
    list: obj.list,
  };
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
  /**
   * Per-row hit-type override (RFC 0003 F4, #603). A vendor repo aggregates
   * many files (with potentially different hit types) into ONE source snapshot,
   * so hit type cannot be a single snapshot-level value. Absent ⇒ the row falls
   * back to the snapshot-level default (`ImportFeedParams.hitType`). Folded into
   * `feed_hash` ONLY when present, so a default-using row hashes unchanged.
   */
  hitType?: HitType;
  /**
   * Per-row classification override (RFC 0003 F4, #603). Absent ⇒ falls back to
   * the snapshot-level default. Folded into `feed_hash` only when present.
   */
  classification?: string;
  /**
   * Central CIB guard (RFC 0003 F4, #603). When `false`, the import path forces
   * this row to `soft_reputation` regardless of `hitType` / the snapshot default
   * — non-malware / influence-ops content (Meta CIB) can NEVER become a
   * deterministic / floor-eligible match. Absent ⇒ no downgrade. The forced
   * `soft_reputation` is folded into `feed_hash` so flipping the guard re-imports.
   */
  deterministicAllowed?: boolean;
}

/**
 * Resolve a row's effective hit type, applying the central CIB guard: a row
 * flagged `deterministicAllowed: false` is forced to `soft_reputation`
 * regardless of its own `hitType` or the snapshot default. Otherwise the row's
 * `hitType` override wins, else the snapshot-level default. The single
 * chokepoint both the INSERT and the feed hash resolve through, so persisted
 * `hit_type` and `feed_hash` always agree.
 */
export function resolveRowHitType(
  row: FeedSnapshotRow,
  defaultHitType: HitType | null,
): HitType | null {
  if (row.deterministicAllowed === false) return "soft_reputation";
  return row.hitType ?? defaultHitType;
}

/**
 * The hash suffix that encodes a row's hit-type / classification override, or
 * `undefined` when the row carries none (so it hashes byte-for-byte as before
 * #603 — the existing five feeds keep their `feed_hash`). The CIB guard's forced
 * `soft_reputation` counts as an override so flipping the guard moves the hash.
 * Only the row's OWN override fields are folded (never the snapshot default), so
 * a change to the snapshot-level default does not by itself move `feed_hash`.
 */
function rowOverrideHashSuffix(row: FeedSnapshotRow): string | undefined {
  const parts: string[] = [];
  const hit =
    row.deterministicAllowed === false ? "soft_reputation" : row.hitType;
  if (hit !== undefined) parts.push(`hit=${hit}`);
  if (row.classification !== undefined) parts.push(`cls=${row.classification}`);
  return parts.length > 0 ? parts.join("\x1f") : undefined;
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
  /**
   * Source polarity (RFC 0003 F5, #599). Omitted ⇒ `positive`. A `negative`
   * import stamps every row `polarity = 'negative'` and forces `hit_type` NULL
   * (a warninglist row carries no hit type — the DB CHECK enforces it).
   */
  polarity?: SourcePolarity;
  /**
   * Intrinsic match type — Tier-1 IOC feeds are `deterministic_ioc`. Required
   * for a positive import; ignored for a `negative` import (rows get NULL
   * `hit_type`).
   */
  hitType?: HitType;
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
  const polarity: SourcePolarity = params.polarity ?? "positive";
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
      // Negative (warninglist) rows carry NO hit_type (#599): force NULL so the
      // polarity/hit_type CHECK holds, regardless of `params.hitType`. Positive
      // rows resolve their hit type per row through the central CIB guard
      // (#603): a `deterministicAllowed: false` row is forced to
      // `soft_reputation` — not trusting whatever a payload declared.
      const hitType =
        polarity === "negative"
          ? null
          : resolveRowHitType(row, params.hitType ?? null);
      const classification = row.classification ?? params.classification;
      await client.query(
        `INSERT INTO ioc_feed_snapshot
           (source_policy_id, entity_type, match_value, cidr, hit_type,
            polarity, classification, confidence, context, source_version,
            feed_hash, source_updated_at)
         VALUES ($1, $2, $3, $4::cidr, $5, $6, $7, $8, $9::jsonb, $10, $11,
                 $12::timestamptz)`,
        [
          params.sourcePolicyId,
          row.entityType ?? params.entityType,
          row.matchValue ?? null,
          row.cidr ?? null,
          hitType,
          polarity,
          classification ?? null,
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
// Streaming replace-only import (large full-dump sources, #657)
// ---------------------------------------------------------------------------

/** Default staging-load / cursor-fetch batch size for the streaming importer. */
const STREAMING_BATCH_SIZE = 1000;

/**
 * A streamed replace-only import. Mirrors {@link importFeedSnapshot}'s
 * replace-only semantics for a source whose body is too large to buffer (the
 * abuse.ch URLhaus payloads ZIP decompresses to ~2.6 GB — past Node's max
 * string), so neither the content, the full row array, nor a full dedup `Set`
 * may be held in memory. Positive single-entity-type sources only (HASH today);
 * no per-row context / hit-type / classification overrides.
 */
export interface StreamingImportParams {
  sourcePolicyId: string;
  entityType: EntityType;
  /** Omitted ⇒ `positive`. A `negative` import forces `hit_type` NULL. */
  polarity?: SourcePolarity;
  hitType?: HitType;
  classification?: string;
  confidence?: number;
  sourceVersion?: string;
  sourceUpdatedAt?: string;
  /** The decompressed feed lines (one per line, no trailing newline). */
  lines: AsyncIterable<string>;
  /** Extract raw indicator value(s) from one DATA line (pre-normalization). */
  extractValues: (line: string) => string[];
  /** Comment prefixes for the data-line / zero-row guard. Defaults `#`/`;`. */
  commentPrefixes?: readonly string[];
  /** Staging-load / cursor-fetch batch size (tests override). */
  batchSize?: number;
}

/**
 * Stream a source's feed lines into `ioc_feed_snapshot` with replace-only
 * semantics, holding the whole import in ONE transaction so a failure mid-stream
 * rolls back and leaves the prior snapshot intact (failure→stale).
 *
 * The pipeline keeps memory bounded at every step:
 *   1. advisory lock (same per-source serialization as `importFeedSnapshot`);
 *   2. stream the lines, normalize each extracted value, and batch-load the
 *      normalized values into a TEMP staging table (at most `batchSize` rows in
 *      memory at a time);
 *   3. unparseable guard — data lines arrived but normalized to zero rows →
 *      reject BEFORE any DELETE so a junk/HTML dump can never wipe a good
 *      snapshot (a genuinely empty / comment-only body legitimately clears it);
 *   4. `feed_hash` from a DB-ordered cursor over the DISTINCT staged values fed
 *      into an incremental Node hash — matching `computeFeedHash` (sorted match
 *      values joined by "\n") with no in-JS sort or full-row array;
 *   5. `DELETE` the source's rows, then `INSERT … SELECT DISTINCT … FROM` the
 *      staging table (dedup is DB-side — no in-memory `Set` of all values);
 *   6. `COMMIT`.
 */
export async function importFeedSnapshotStreaming(
  pool: Pool,
  params: StreamingImportParams,
): Promise<{ rowCount: number; feedHash: string }> {
  const polarity: SourcePolarity = params.polarity ?? "positive";
  const prefixes = params.commentPrefixes ?? DEFAULT_COMMENT_PREFIXES;
  const batchSize = params.batchSize ?? STREAMING_BATCH_SIZE;
  // Negative (warninglist) rows carry NO hit_type (mirrors `importFeedSnapshot`).
  const hitType = polarity === "negative" ? null : (params.hitType ?? null);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock($1)", [
      feedSourceLockKey(params.sourcePolicyId),
    ]);
    // `COLLATE "C"` (byte order) so the DB-ordered `feed_hash` cursor agrees
    // with `computeFeedHash`'s JS string sort over the ASCII match values, and
    // DISTINCT/ORDER BY need no per-query collation override.
    await client.query(
      `CREATE TEMP TABLE _feed_stage
         (match_value text COLLATE "C" NOT NULL) ON COMMIT DROP`,
    );

    let dataLineCount = 0;
    let batch: string[] = [];
    const flush = async (): Promise<void> => {
      if (batch.length === 0) return;
      const placeholders = batch.map((_, i) => `($${i + 1})`).join(",");
      await client.query(
        `INSERT INTO _feed_stage (match_value) VALUES ${placeholders}`,
        batch,
      );
      batch = [];
    };

    for await (const raw of params.lines) {
      const line = raw.trim();
      if (line.length === 0 || isCommentLine(line, prefixes)) continue;
      dataLineCount += 1;
      for (const value of params.extractValues(line)) {
        let normalized: string;
        try {
          normalized = normalizeForEntity(params.entityType, value);
        } catch (err) {
          if (err instanceof NormalizationError) continue;
          throw err;
        }
        batch.push(normalized);
        if (batch.length >= batchSize) await flush();
      }
    }
    await flush();

    const { rows: countRows } = await client.query<{ cnt: string }>(
      `SELECT COUNT(DISTINCT match_value)::text AS cnt FROM _feed_stage`,
    );
    const distinctCount = Number(countRows[0].cnt);

    // Unparseable guard (streamed): data lines arrived but parsed to zero rows
    // → fail (failure→stale) instead of clearing the snapshot. A body with no
    // data lines (header/comment only) legitimately clears the source.
    if (dataLineCount > 0 && distinctCount === 0) {
      throw new FeedParseError(
        "Fetched response has data but no recognizable feed entries " +
          "(possible upstream error/block page or format drift)",
      );
    }

    const feedHash = await computeStreamedFeedHash(client, batchSize);

    await client.query(
      `DELETE FROM ioc_feed_snapshot WHERE source_policy_id = $1`,
      [params.sourcePolicyId],
    );
    await client.query(
      `INSERT INTO ioc_feed_snapshot
         (source_policy_id, entity_type, match_value, cidr, hit_type,
          polarity, classification, confidence, context, source_version,
          feed_hash, source_updated_at)
       SELECT $1, $2, s.match_value, NULL, $3, $4, $5, $6, NULL, $7, $8,
              $9::timestamptz
         FROM (SELECT DISTINCT match_value FROM _feed_stage) AS s`,
      [
        params.sourcePolicyId,
        params.entityType,
        hitType,
        polarity,
        params.classification ?? null,
        params.confidence ?? null,
        params.sourceVersion ?? null,
        feedHash,
        params.sourceUpdatedAt ?? null,
      ],
    );
    await client.query("COMMIT");
    return { rowCount: distinctCount, feedHash };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Stable `feed_hash` over the DISTINCT staged values without an in-memory sort:
 * let Postgres order the values (byte order via `COLLATE "C"`, so it agrees with
 * `computeFeedHash`'s JS string sort over the ASCII match values), fetch them in
 * batches through a cursor, and feed each into an incremental sha256 with the
 * same "\n" separator `computeFeedHash` uses. An empty staging table hashes the
 * empty string — identical to `computeFeedHash([])`.
 */
async function computeStreamedFeedHash(
  client: PoolClient,
  fetchSize: number,
): Promise<string> {
  await client.query(
    `DECLARE feed_hash_cur NO SCROLL CURSOR FOR
       SELECT DISTINCT match_value FROM _feed_stage
       ORDER BY match_value`,
  );
  const hash = createHash("sha256");
  let first = true;
  try {
    for (;;) {
      const { rows } = await client.query<{ match_value: string }>(
        `FETCH ${fetchSize} FROM feed_hash_cur`,
      );
      if (rows.length === 0) break;
      for (const row of rows) {
        if (!first) hash.update("\n");
        hash.update(row.match_value);
        first = false;
      }
    }
  } finally {
    await client.query("CLOSE feed_hash_cur").catch(() => {});
  }
  return hash.digest("hex");
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
      return groupedRows(parseCsvColumns(content, config));
    }
    case "free-text": {
      const cfg = config?.kind === "free-text" ? config : undefined;
      // The scanner self-classifies each token's entity type, so the rows are
      // grouped + normalized per type exactly like `csv-column`.
      return groupedRows(parseFreeTextIocs(content, cfg));
    }
    case "misp-warninglist":
      // The negative layer's bespoke JSON-array parser (RFC 0003 F5, #615):
      // it already normalizes its own rows (cidr / exact IP) and stamps each
      // with its source list's `name`, so `entityType` is unused (v1 is IP-only).
      return parseMispWarninglists(content);
    default:
      throw new Error(`unknown parse kind: ${parse}`);
  }
}

/**
 * Normalize per-entity-type `{ entityType, value }` extractions (`csv-column`'s
 * columns or the `free-text` scanner's tokens) into snapshot rows: group by
 * entity type, run each group through the same `normalizeExactValues` the
 * bespoke parsers use, and stamp every row with its `entityType` (so a
 * multi-type source contributes more than one entity type under one source,
 * like URLhaus' URL+DOMAIN). Per-type de-duplication is inherited from
 * `normalizeExactValues`.
 */
function groupedRows(
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
    (config.skipHeader === true || csvConfigUsesNames(config))
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
 * accepted the config). A `csv-column` config that does intentional per-row
 * skips (the row-typed `typeColumn` map and/or a `rowFilter` allowlist, #605)
 * may drop every data row yet remain a fully recognized body (e.g. an
 * all-`legitimate` Infoblox file); once such a config is satisfied, zero rows
 * is a legitimate clear too, not a parse error. The comment prefix is taken
 * from the parser's config so the data-line check agrees with the parser.
 * Shared by the manual-upload validation and the self-fetch engine so neither
 * replaces a good snapshot with junk.
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
  // header-only body is a legitimate clear.
  if (parserSkipsHeader(parse, config) && dataCount === 1) return false;
  // A `csv-column` config that performs intentional per-row skips — the
  // row-typed `typeColumn` map and/or a `rowFilter` allowlist (#605, Infoblox)
  // — can legitimately drop EVERY data row and still be a fully recognized
  // body: an all-`legitimate` upstream file, or one carrying only
  // `email`/`telfhash`/future-type rows, parses to zero rows by design. For
  // these the row count is NOT the schema-recognition signal — a satisfied
  // config (header names resolved / indices in range; raised no
  // `FeedParseError` above) is. A malformed / HTML body fails that and already
  // returned true. So zero rows here is a legitimate clear, not a parse error.
  if (
    parse === "csv-column" &&
    config?.kind === "csv-column" &&
    (config.typeColumn !== undefined ||
      config.shapeColumn !== undefined ||
      config.rowFilter !== undefined)
  ) {
    return false;
  }
  // For non-header parsers and static per-column csv configs, zero rows from
  // data lines is unparseable.
  return true;
}

/**
 * Parse + normalize one raw feed payload's content into snapshot rows WITHOUT
 * importing (RFC 0003 F4, #603). The parse-only seam the vendor-repo batch path
 * needs: it gathers rows across MANY files for one source, then replaces once
 * (`importFeedSnapshot`) — so it cannot use `importRawFeedPayload` (a per-file
 * replace would clobber all but the last file).
 *
 * The payload's report-level `context` is stamped onto every produced row, and
 * a `deterministicAllowed: false` guard is stamped through to each row (the
 * import path forces those rows to `soft_reputation` centrally). A context-less,
 * guard-less payload (the existing five feeds) returns the parser's rows
 * unchanged, so its `feed_hash` is byte-for-byte identical.
 */
export function parseRawFeedPayloadRows(
  payload: RawFeedPayload,
): FeedSnapshotRow[] {
  const rows = parseFeedContent(
    payload.parse,
    payload.entityType,
    payload.content,
    payload.parseConfig,
  );
  const guardDowngrade = payload.deterministicAllowed === false;
  if (!payload.context && !guardDowngrade) return rows;
  return rows.map((row) => {
    const stamped: FeedSnapshotRow = { ...row };
    if (payload.context) stamped.context = payload.context;
    if (guardDowngrade) stamped.deterministicAllowed = false;
    return stamped;
  });
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
    polarity: payload.polarity,
    hitType: payload.hitType,
    classification: payload.classification,
    sourceVersion: payload.provenance.sourceVersion,
    sourceUpdatedAt: payload.provenance.sourceUpdatedAt,
    rows: parseRawFeedPayloadRows(payload),
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
 * hashes byte-for-byte as it did before this change — the context-less
 * feeds keep their exact `feed_hash` (no spurious re-import). Context is
 * serialized with `canonicalizeContext` (sorted keys), not a bare
 * `JSON.stringify`, so the same context with a different key-insertion order
 * hashes identically and does not trigger a phantom re-import; a genuine
 * context change does change the hash and re-imports.
 *
 * A per-row `hitType` / `classification` override (RFC 0003 F4, #603) — or the
 * CIB guard's forced `soft_reputation` — is folded after a double-NUL marker,
 * again ONLY when the row carries one, so flipping a row's hit type re-imports
 * (the re-import is not silently skipped). A row that falls back to the
 * snapshot-level default folds nothing and hashes exactly as before.
 */
export function computeFeedHash(rows: readonly FeedSnapshotRow[]): string {
  const entries = rows
    .map((r) => {
      const base = r.matchValue ?? `cidr:${r.cidr}`;
      const ctx = r.context ? normalizeContext(r.context) : undefined;
      const withCtx = ctx ? `${base}\0${canonicalizeContext(ctx)}` : base;
      const override = rowOverrideHashSuffix(r);
      return override ? `${withCtx}\0\0${override}` : withCtx;
    })
    .sort()
    .join("\n");
  return createHash("sha256").update(entries).digest("hex");
}
