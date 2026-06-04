// RFC 0003 P1a (#361) — extract normalized indicators from stored,
// already-redacted member sources (RFC 0003 worker step 1): the
// `story_member.event` JSONB and the discrete `policy_event` columns
// (`orig_addr`/`resp_addr`/`host`/`dns_query`/`uri`) for the same
// event_key. The caller passes them as one value (any JSON shape — object,
// array of strings, or a mix); this walker handles all of them.
//
// Indicators are drawn from the stored member rows, matching the CURRENT
// redaction reality (no RFC 0001 Amendment A / #424 dependency):
//
//   * External / pass-through IPs are stored RAW in member text (empty or
//     non-matching range set → `shouldRedactPublicIP` is false), read
//     directly.
//   * Customer-asset IPs (private/reserved, or inside a registered range)
//     are TOKENIZED; the caller supplies a `recover` closure built from
//     the decrypted event redaction map so the value can be matched.
//   * Domains / URLs / hashes are NOT redacted in v1 (the engine only
//     tokenizes ip/email/mac), so they are stored raw and read directly.
//
// Each extracted indicator carries the `redactionToken` used as its
// evidence identity reference: the token string for a recovered
// customer-asset value, or the raw indicator itself for an external
// pass-through value (RFC 0003 §"Audit / evidence model").

import { getDomain } from "tldts";
import type { EntityKind } from "@/lib/redaction/types";
import {
  NormalizationError,
  normalizeDomain,
  normalizeHash,
  normalizeIp,
  normalizeUrl,
  serializeIndicator,
} from "./normalization";
import type { NormalizedIndicator } from "./types";

export interface ExtractedIndicator {
  indicator: NormalizedIndicator;
  /** Evidence identity reference (token for recovered, raw value otherwise). */
  redactionToken: string;
}

/** Resolve an event-scope redaction token to its `{ kind, value }`. */
export type RecoverToken = (
  token: string,
) => { kind: EntityKind; value: string } | undefined;

// Event-scope redaction tokens as stored in `story_member.event` (the
// story-scope `E{i}` rewrite happens later, at analysis time, not on disk).
const TOKEN_RE = /<<REDACTED_(?:IP|EMAIL|MAC)_\d+>>/g;
const URL_RE = /\bhttps?:\/\/[^\s"'<>()]+/gi;
const IPV4_RE = /(?<!\d\.)(?<!\d)(?:\d{1,3}\.){3}\d{1,3}(?!\.?\d)/g;
// Permissive IPv6 matcher; candidates are validated by `normalizeIp`.
const IPV6_RE =
  /\b(?:[0-9a-fA-F]{1,4}:){2,7}[0-9a-fA-F]{0,4}(?:::)?[0-9a-fA-F:]*\b/g;
const HASH_RE = /\b(?:[0-9a-fA-F]{64}|[0-9a-fA-F]{40}|[0-9a-fA-F]{32})\b/g;
const DOMAIN_RE =
  /\b(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}\b/g;

// Common file extensions whose dotted tokens (`report.tmp`, `app.exe`)
// otherwise pass `tldts` (which accepts unknown TLDs). Filtering these
// keeps domain extraction precise. A real malicious domain on a real TLD
// is unaffected; an over-extracted filename would only ever miss in the
// feed table anyway, so this is precision, not correctness.
const FILE_EXTENSIONS = new Set([
  "tmp",
  "exe",
  "dll",
  "zip",
  "rar",
  "gz",
  "tar",
  "pdf",
  "doc",
  "docx",
  "xls",
  "xlsx",
  "ppt",
  "pptx",
  "txt",
  "log",
  "csv",
  "json",
  "xml",
  "html",
  "htm",
  "js",
  "css",
  "png",
  "jpg",
  "jpeg",
  "gif",
  "svg",
  "bin",
  "dat",
  "bat",
  "ps1",
  "sh",
  "dmg",
  "iso",
  "msi",
  "lnk",
]);

/**
 * Extract de-duplicated normalized indicators from an event JSONB value.
 * Walks every string scalar; recovers tokenized IPs via `recover`; scans
 * the remaining (token-stripped) text for raw IP / URL / hash / domain
 * indicators. De-duplicated by canonical serialization, keeping the first
 * `redactionToken` seen for each.
 */
export function extractIndicators(
  event: unknown,
  recover: RecoverToken,
): ExtractedIndicator[] {
  const out: ExtractedIndicator[] = [];
  const seen = new Set<string>();

  const add = (
    indicator: NormalizedIndicator,
    redactionToken: string,
  ): void => {
    const key = serializeIndicator(indicator);
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ indicator, redactionToken });
  };

  for (const text of collectStrings(event)) {
    extractFromString(text, recover, add);
  }
  return out;
}

function extractFromString(
  text: string,
  recover: RecoverToken,
  add: (indicator: NormalizedIndicator, redactionToken: string) => void,
): void {
  // 1. Recover tokenized customer-asset IPs (email/mac tokens are not IOC
  //    entity types and are skipped).
  for (const token of text.match(TOKEN_RE) ?? []) {
    const recovered = recover(token);
    if (recovered?.kind === "ip") {
      tryNormalize(() => normalizeIp(recovered.value), token, add);
    }
  }

  // 2. Strip tokens, then scan the remainder for raw indicators. URLs are
  //    captured first and blanked so their host is not double-matched as a
  //    bare domain.
  let remainder = text.replace(TOKEN_RE, " ");

  remainder = scanAndBlank(remainder, URL_RE, (m) =>
    tryNormalize(() => normalizeUrl(m), m, add),
  );
  remainder = scanAndBlank(remainder, IPV4_RE, (m) =>
    tryNormalize(() => normalizeIp(m), m, add),
  );
  remainder = scanAndBlank(remainder, IPV6_RE, (m) =>
    tryNormalize(() => normalizeIp(m), m, add),
  );
  remainder = scanAndBlank(remainder, HASH_RE, (m) =>
    tryNormalize(() => normalizeHash(m), m, add),
  );
  // Domains last: only accept candidates the public-suffix list resolves
  // to a registered domain, filtering filenames and version-like tokens.
  scanAndBlank(remainder, DOMAIN_RE, (m) => {
    if (getDomain(m) === null) return;
    const lastLabel = m.split(".").pop()?.toLowerCase() ?? "";
    if (FILE_EXTENSIONS.has(lastLabel)) return;
    tryNormalize(() => normalizeDomain(m), m, add);
  });
}

function tryNormalize(
  normalize: () => NormalizedIndicator,
  redactionToken: string,
  add: (indicator: NormalizedIndicator, redactionToken: string) => void,
): void {
  try {
    add(normalize(), redactionToken);
  } catch (err) {
    if (err instanceof NormalizationError) return;
    throw err;
  }
}

/** Apply a global regex, invoke `onMatch` per hit, and blank the matches. */
function scanAndBlank(
  text: string,
  re: RegExp,
  onMatch: (match: string) => void,
): string {
  const matches = text.match(re);
  if (!matches) return text;
  for (const m of matches) onMatch(m);
  return text.replace(re, " ");
}

/** Recursively collect every string scalar from a JSON value. */
function collectStrings(value: unknown, acc: string[] = []): string[] {
  if (typeof value === "string") {
    acc.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, acc);
  } else if (value !== null && typeof value === "object") {
    for (const v of Object.values(value)) collectStrings(v, acc);
  }
  return acc;
}
