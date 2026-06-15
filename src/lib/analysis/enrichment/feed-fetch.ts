// RFC 0003 Tier-1 feed-refresh (3a, #568) — the self-fetch engine.
//
// On-prem / sovereignty deployments fetch the Tier-1 feeds (abuse.ch /
// Spamhaus) directly over HTTP — the license-sanctioned, no-redistribution
// path — and import them through the SAME common downstream as every other
// supply mode (`importRawFeedPayload`). A `SelfFetchFeedSource` yields the
// fetched bytes + provenance; nothing about parsing/normalization changes.
//
// Two callers drive this engine: the operator-triggered "Fetch Now" (3a) and
// the background scheduler (3b, #570, `self-fetch-worker.ts`), which calls
// `fetchAndImport` on a timer for due sources. Either way each fetch is
// single-flighted with a per-source advisory lock and guarded by a hard
// cadence floor, so neither a trigger-happy operator nor the scheduler can get
// the instance IP-banned.
//
// Snapshot writes are strictly replace-only via `importRawFeedPayload`. The
// ONLY thing a 304 / empty / failed fetch changes is `feed_fetch_state`
// (never an in-place `ioc_feed_snapshot` mutation): freshness/presence for
// self-fetch is read from `feed_fetch_state.last_fetched_at`, not row count
// (see `PgFeedStore.probe`).

import "server-only";

import { createHash } from "node:crypto";
import { once } from "node:events";
import { Readable } from "node:stream";
import type { ReadableStream as NodeWebReadableStream } from "node:stream/web";
import { StringDecoder } from "node:string_decoder";
import { createInflateRaw } from "node:zlib";
import type { Pool } from "pg";
import { decryptPayload, encryptPayload } from "@/lib/crypto/envelope";
import {
  FETCH_AUTH_KEY_PLACEHOLDER,
  getTier1FeedSource,
  TIER1_FEED_SOURCES,
  type Tier1FetchConfig,
} from "./feed-catalog";
import {
  importFeedSnapshotStreaming,
  importRawFeedPayload,
  isUnparseableFeedContent,
  parseUrlhausPayloadsCsvLine,
} from "./feed-import";
import {
  type FeedParseKind,
  type RawFeedPayload,
  resolveTiFeedMode,
  type TiFeedMode,
  type VendorRepoConfig,
} from "./feed-source";
import {
  importVendorRepo,
  LiveVendorRepoProvider,
  VENDOR_REPO_DEFAULT_CADENCE_FLOOR_MS,
  type VendorRepoCollectInput,
} from "./feed-vendor-repo";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Advisory-lock namespace for per-source self-fetch single-flight, distinct
 * from the enrichment worker's namespace (`0x361a`) so they never contend.
 */
export const FEED_FETCH_LOCK_NS = 0x568f;

/** Outbound fetch timeout (ms) — abuse.ch / Spamhaus are normally prompt. */
export const DEFAULT_FETCH_TIMEOUT_MS = 30_000;

/** Transit key name the URLhaus Auth-Key (and any future secret) wraps under. */
export const FEED_SECRET_TRANSIT_KEY = "feed-secrets";

// ---------------------------------------------------------------------------
// Injectable HTTP transport (tests mock 200 / 304 / failure — never live)
// ---------------------------------------------------------------------------

/** The subset of `Response` the engine needs (so tests can fake it). */
export interface FetchResponseLike {
  status: number;
  ok: boolean;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
  /**
   * The response body as a byte stream, for the streaming-decompress path
   * (`decompress: "zip"`) — consumed instead of `text()` so a multi-hundred-MB
   * archive is never buffered. `null` when the body is absent/already consumed;
   * the buffered `text()` path ignores it.
   */
  body: NodeWebReadableStream<Uint8Array> | ReadableStream<Uint8Array> | null;
}

/** An injectable outbound-HTTP transport. Defaults to global `fetch`. */
export type FetchTransport = (
  url: string,
  init: { headers: Record<string, string>; signal: AbortSignal },
) => Promise<FetchResponseLike>;

const defaultTransport: FetchTransport = (url, init) =>
  fetch(url, { method: "GET", headers: init.headers, signal: init.signal });

// ---------------------------------------------------------------------------
// Streaming decompression (ZIP single-entry) + line reader — unit-tested (#657)
// ---------------------------------------------------------------------------

const ZIP_LOCAL_FILE_HEADER_SIG = 0x04034b50;
const ZIP_LOCAL_FILE_HEADER_LEN = 30;
const ZIP_GP_FLAG_ENCRYPTED = 0x1;
const ZIP_METHOD_DEFLATE = 8;

/**
 * Inflate the SINGLE entry of a ZIP archive as a stream, returning a `Readable`
 * of the decompressed bytes. Node's `zlib` has no streaming ZIP-container reader
 * (gzip/deflate/brotli only), so the ZIP local-file header is parsed by hand and
 * the lone DEFLATE entry is piped through `createInflateRaw()`; the inflate ends
 * at the DEFLATE stream's end, so any trailing bytes (data descriptor, central
 * directory) after the sole entry are ignored — no member name is hardcoded and
 * the entry's declared compressed size is not needed.
 *
 * It is a ZIP archive, NOT gzip — `gunzip`/`createGunzip` would not parse it.
 * An encrypted entry, a non-DEFLATE method, a bad signature, or a truncated
 * header surface as a `SelfFetchError` rather than a silent zero-row import.
 */
export function openSingleZipEntry(input: Readable): Readable {
  // `Readable.from` is lazy: the generator (and therefore the header parse)
  // only advances when the result is consumed, so a header-parse error surfaces
  // to the reader's iteration rather than as an unhandled `error` event fired
  // before any consumer has attached.
  return Readable.from(inflateSingleEntry(input));
}

/**
 * Parse the ZIP local-file header off the front of `input`, then inflate the
 * lone DEFLATE entry, yielding the decompressed bytes. The entry's compressed
 * bytes are fed into `createInflateRaw()` in the background (honoring
 * backpressure) while this generator yields the inflate output; the inflate
 * ends at the DEFLATE stream's end, so trailing bytes after the sole entry are
 * ignored. A truncation / unsupported-encoding / source error propagates out of
 * the generator (and so to the consumer's read).
 */
async function* inflateSingleEntry(input: Readable): AsyncGenerator<Buffer> {
  const reader = input[Symbol.asyncIterator]();
  let head = Buffer.alloc(0);
  const pull = async (): Promise<boolean> => {
    const next = await reader.next();
    if (next.done) return false;
    head = Buffer.concat([head, Buffer.from(next.value)]);
    return true;
  };

  while (head.length < ZIP_LOCAL_FILE_HEADER_LEN) {
    if (!(await pull())) {
      throw new SelfFetchError(
        "ZIP archive is truncated (no local file header)",
      );
    }
  }
  if (head.readUInt32LE(0) !== ZIP_LOCAL_FILE_HEADER_SIG) {
    throw new SelfFetchError("Fetched body is not a ZIP archive");
  }
  if ((head.readUInt16LE(6) & ZIP_GP_FLAG_ENCRYPTED) !== 0) {
    throw new SelfFetchError("ZIP archive entry is encrypted (unsupported)");
  }
  const method = head.readUInt16LE(8);
  if (method !== ZIP_METHOD_DEFLATE) {
    throw new SelfFetchError(
      `Unsupported ZIP compression method ${method} (expected DEFLATE)`,
    );
  }
  const nameLen = head.readUInt16LE(26);
  const extraLen = head.readUInt16LE(28);
  const headerLen = ZIP_LOCAL_FILE_HEADER_LEN + nameLen + extraLen;
  while (head.length < headerLen) {
    if (!(await pull())) {
      throw new SelfFetchError(
        "ZIP archive is truncated (incomplete local file header)",
      );
    }
  }

  const inflate = createInflateRaw();
  const feeding = (async (): Promise<void> => {
    const write = async (chunk: Buffer): Promise<void> => {
      if (!inflate.write(chunk)) await once(inflate, "drain");
    };
    const remainder = head.subarray(headerLen);
    if (remainder.length > 0) await write(remainder);
    for (;;) {
      const next = await reader.next();
      if (next.done) break;
      await write(Buffer.from(next.value));
    }
    inflate.end();
  })();
  // Surface a feed-side error (network drop, abort) through the inflate stream
  // so the consumer's iteration throws instead of hanging.
  feeding.catch((err) =>
    inflate.destroy(err instanceof Error ? err : new Error(String(err))),
  );

  try {
    for await (const chunk of inflate) yield chunk as Buffer;
  } finally {
    input.destroy();
    await feeding.catch(() => {});
  }
}

/**
 * Split a byte `Readable` into lines (LF / CRLF), decoding UTF-8 across chunk
 * boundaries. No newline-terminator is required on the final line. Used to
 * line-parse a decompressed feed without buffering the whole body.
 */
export async function* readLines(stream: Readable): AsyncGenerator<string> {
  const decoder = new StringDecoder("utf8");
  let buf = "";
  for await (const chunk of stream) {
    buf += decoder.write(chunk as Buffer);
    let idx = buf.indexOf("\n");
    while (idx !== -1) {
      let line = buf.slice(0, idx);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      yield line;
      buf = buf.slice(idx + 1);
      idx = buf.indexOf("\n");
    }
  }
  buf += decoder.end();
  if (buf.length > 0) {
    if (buf.endsWith("\r")) buf = buf.slice(0, -1);
    yield buf;
  }
}

/**
 * The per-line value extractor for a streaming-decompress source's `parse` kind.
 * Only kinds wired for streaming are supported (today the URLhaus payloads CSV);
 * anything else is a misconfiguration and throws rather than silently importing
 * nothing.
 */
function streamingLineExtractor(
  parse: FeedParseKind,
): (line: string) => string[] {
  switch (parse) {
    case "urlhaus-payloads-csv":
      return parseUrlhausPayloadsCsvLine;
    default:
      throw new SelfFetchError(
        `streaming decompress is not supported for parse kind "${parse}"`,
      );
  }
}

// ---------------------------------------------------------------------------
// Mode gating
// ---------------------------------------------------------------------------

/**
 * Whether `self-fetch` is the active supply mode (`TI_FEED_MODE`). A reserved
 * -but-unimplemented mode makes `resolveTiFeedMode` throw — treated here as
 * "not active" so the self-fetch routes/UI are inactive (404) outside it.
 */
export function selfFetchModeActive(
  value: string | undefined = process.env.TI_FEED_MODE,
): boolean {
  try {
    return resolveTiFeedMode(value) === "self-fetch";
  } catch {
    return false;
  }
}

/**
 * Whether the SHARED `ti-feeds` admin surface (page + status GET + nav) is
 * active: it is in EITHER `manual-upload` or `self-fetch` (the two modes that
 * have an operator-facing feed page). The mode-specific controls (`/upload`
 * vs `/fetch` + `/auth-key`) gate on their own mode separately.
 */
export function tiFeedAdminSurfaceActive(
  value: string | undefined = process.env.TI_FEED_MODE,
): boolean {
  try {
    const mode = resolveTiFeedMode(value);
    return mode === "manual-upload" || mode === "self-fetch";
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Pure helpers (conditional GET + cadence floor) — unit-tested
// ---------------------------------------------------------------------------

/** The `feed_fetch_state` row shape (as read from the feed DB). */
export interface FeedFetchState {
  sourcePolicyId: string;
  lastFetchedAt: string | null;
  lastAttemptAt: string | null;
  etag: string | null;
  lastModified: string | null;
  lastStatus: string | null;
  lastError: string | null;
  lastRowCount: number | null;
}

/**
 * Conditional-GET request headers from prior fetch state: `If-None-Match`
 * from the stored ETag, `If-Modified-Since` from the stored `Last-Modified`.
 * Empty when no validators are known (first fetch).
 */
export function conditionalGetHeaders(
  state: FeedFetchState | null,
): Record<string, string> {
  const headers: Record<string, string> = {};
  if (state?.etag) headers["If-None-Match"] = state.etag;
  if (state?.lastModified) headers["If-Modified-Since"] = state.lastModified;
  return headers;
}

/**
 * The earliest time this source may next be fetched (`last_fetched_at +
 * cadenceFloor`), or `null` if it has never been fetched (fetch immediately).
 */
export function nextFetchAllowedAt(
  state: FeedFetchState | null,
  cadenceFloorMs: number,
): Date | null {
  if (!state?.lastFetchedAt) return null;
  return new Date(new Date(state.lastFetchedAt).getTime() + cadenceFloorMs);
}

/**
 * Whether fetching `now` would violate the source's hard cadence floor
 * (i.e. the last successful fetch is more recent than the floor allows).
 */
export function withinCadenceFloor(
  state: FeedFetchState | null,
  cadenceFloorMs: number,
  now: Date,
): boolean {
  const allowed = nextFetchAllowedAt(state, cadenceFloorMs);
  return allowed !== null && now.getTime() < allowed.getTime();
}

/**
 * Resolve a source's fetch URL(s), substituting the Auth-Key into the path
 * where the placeholder appears. Throws when the source needs an Auth-Key
 * that has not been provided.
 */
export function resolveFetchUrls(
  fetchConfig: Tier1FetchConfig,
  authKey: string | null,
): string[] {
  return fetchConfig.urls.map((url) => {
    if (!url.includes(FETCH_AUTH_KEY_PLACEHOLDER)) return url;
    if (!authKey) {
      throw new SelfFetchError("Auth-Key is required for this source");
    }
    return url
      .split(FETCH_AUTH_KEY_PLACEHOLDER)
      .join(encodeURIComponent(authKey));
  });
}

/** A fetch failure surfaced to the operator (network/timeout/4xx/5xx/config). */
export class SelfFetchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SelfFetchError";
  }
}

// ---------------------------------------------------------------------------
// Auth-Key secret store (Transit-envelope, write-only) — #568 §7
// ---------------------------------------------------------------------------

/**
 * Store (or replace) a self-fetch secret (the URLhaus Auth-Key) encrypted at
 * rest: a fresh DEK is generated via Transit, the value is AES-256-GCM
 * encrypted under it, and the Transit-wrapped DEK is persisted alongside the
 * ciphertext. The plaintext is never written. Write-only — there is no read
 * path back to the UI, only `feedSourceSecretStatus` (set/unset) and the
 * fetch-time decrypt (`readFeedSourceAuthKey`).
 */
export async function setFeedSourceSecret(
  pool: Pool,
  keyName: string,
  plaintext: string,
): Promise<void> {
  const { ciphertext, wrappedDek } = await encryptPayload(
    Buffer.from(plaintext, "utf8"),
    FEED_SECRET_TRANSIT_KEY,
  );
  await pool.query(
    `INSERT INTO feed_source_secret (key_name, wrapped_dek, ciphertext, updated_at)
       VALUES ($1, $2, $3, NOW())
     ON CONFLICT (key_name) DO UPDATE
       SET wrapped_dek = EXCLUDED.wrapped_dek,
           ciphertext  = EXCLUDED.ciphertext,
           updated_at  = NOW()`,
    [keyName, wrappedDek, ciphertext],
  );
}

/** Decrypt a stored self-fetch secret at fetch time, or `null` if unset. */
export async function readFeedSourceAuthKey(
  pool: Pool,
  keyName: string,
): Promise<string | null> {
  const { rows } = await pool.query<{
    wrapped_dek: string;
    ciphertext: Buffer;
  }>(
    `SELECT wrapped_dek, ciphertext FROM feed_source_secret WHERE key_name = $1`,
    [keyName],
  );
  const row = rows[0];
  if (!row) return null;
  const plaintext = await decryptPayload(
    row.ciphertext,
    row.wrapped_dek,
    FEED_SECRET_TRANSIT_KEY,
  );
  try {
    return plaintext.toString("utf8");
  } finally {
    plaintext.fill(0);
  }
}

/** Which secret `key_name`s are set (presence only — never the value). */
export async function feedSourceSecretStatus(pool: Pool): Promise<Set<string>> {
  const { rows } = await pool.query<{ key_name: string }>(
    `SELECT key_name FROM feed_source_secret`,
  );
  return new Set(rows.map((r) => r.key_name));
}

// ---------------------------------------------------------------------------
// feed_fetch_state read / record
// ---------------------------------------------------------------------------

function toIso(value: Date | string | null): string | null {
  if (value == null) return null;
  return value instanceof Date ? value.toISOString() : String(value);
}

export async function readFeedFetchState(
  pool: Pool,
  sourcePolicyId: string,
): Promise<FeedFetchState | null> {
  const { rows } = await pool.query<{
    source_policy_id: string;
    last_fetched_at: Date | null;
    last_attempt_at: Date | null;
    etag: string | null;
    last_modified: string | null;
    last_status: string | null;
    last_error: string | null;
    last_row_count: number | null;
  }>(
    `SELECT source_policy_id, last_fetched_at, last_attempt_at, etag,
            last_modified, last_status, last_error, last_row_count
       FROM feed_fetch_state WHERE source_policy_id = $1`,
    [sourcePolicyId],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    sourcePolicyId: row.source_policy_id,
    lastFetchedAt: toIso(row.last_fetched_at),
    lastAttemptAt: toIso(row.last_attempt_at),
    etag: row.etag,
    lastModified: row.last_modified,
    lastStatus: row.last_status,
    lastError: row.last_error,
    lastRowCount: row.last_row_count,
  };
}

/** Record a successful 200 import: bump fetch clock + store validators. */
async function recordOk(
  pool: Pool,
  sourcePolicyId: string,
  args: {
    nowIso: string;
    etag: string | null;
    lastModified: string | null;
    rowCount: number;
  },
): Promise<void> {
  await pool.query(
    `INSERT INTO feed_fetch_state
       (source_policy_id, last_fetched_at, last_attempt_at, etag,
        last_modified, last_status, last_error, last_row_count, updated_at)
     VALUES ($1, $2, $2, $3, $4, 'ok', NULL, $5, $2)
     ON CONFLICT (source_policy_id) DO UPDATE
       SET last_fetched_at = $2, last_attempt_at = $2, etag = $3,
           last_modified = $4, last_status = 'ok', last_error = NULL,
           last_row_count = $5, updated_at = $2`,
    [sourcePolicyId, args.nowIso, args.etag, args.lastModified, args.rowCount],
  );
}

/**
 * Record a 304 (Not Modified): the feed is revalidated as current, so bump
 * the fetch clock but leave the snapshot, validators, and row count intact.
 */
async function recordNotModified(
  pool: Pool,
  sourcePolicyId: string,
  nowIso: string,
): Promise<void> {
  await pool.query(
    `INSERT INTO feed_fetch_state
       (source_policy_id, last_fetched_at, last_attempt_at, last_status,
        last_error, updated_at)
     VALUES ($1, $2, $2, 'not-modified', NULL, $2)
     ON CONFLICT (source_policy_id) DO UPDATE
       SET last_fetched_at = $2, last_attempt_at = $2,
           last_status = 'not-modified', last_error = NULL, updated_at = $2`,
    [sourcePolicyId, nowIso],
  );
}

/**
 * Record a failure (failure→stale): record the attempt + error but DO NOT
 * touch `last_fetched_at` / validators / row count, so freshness decays.
 */
async function recordError(
  pool: Pool,
  sourcePolicyId: string,
  nowIso: string,
  error: string,
): Promise<void> {
  await pool.query(
    `INSERT INTO feed_fetch_state
       (source_policy_id, last_attempt_at, last_status, last_error, updated_at)
     VALUES ($1, $2, 'error', $3, $2)
     ON CONFLICT (source_policy_id) DO UPDATE
       SET last_attempt_at = $2, last_status = 'error', last_error = $3,
           updated_at = $2`,
    [sourcePolicyId, nowIso, error.slice(0, 2000)],
  );
}

// ---------------------------------------------------------------------------
// Status aggregation for the admin UI (#568 §9)
// ---------------------------------------------------------------------------

/** Per-source self-fetch status for the admin UI (self-fetch mode). */
export interface SelfFetchSourceStatus {
  sourcePolicyId: string;
  label: string;
  /** `true` when the source has a self-fetch config (EDROP, merged, is not). */
  fetchable: boolean;
  /**
   * Why a non-fetchable source has no self-fetch, so the UI can label it
   * accurately. `"merged"` ⇒ superseded upstream (EDROP into DROP);
   * `"fixture-only"` ⇒ fixture-/manual-upload-only, no aggregate endpoint
   * (e.g. Infoblox). `null` for fetchable sources.
   */
  unavailableReason: "merged" | "fixture-only" | null;
  /** Display URL(s) — the placeholder template, never the real Auth-Key. */
  fetchUrl: string | null;
  /** Whether this source needs an Auth-Key, and whether one is set. */
  authKeyRequired: boolean;
  authKeyName: string | null;
  authKeySet: boolean;
  /** Presence/freshness from `feed_fetch_state` (a successful fetch ⇒ present). */
  present: boolean;
  stale: boolean;
  /** Snapshot row count (informational). */
  rowCount: number;
  lastFetchedAt: string | null;
  lastAttemptAt: string | null;
  lastStatus: string | null;
  lastError: string | null;
  lastRowCount: number | null;
}

/**
 * Per-source self-fetch status for every catalog source, joining the catalog
 * fetch config, `feed_fetch_state`, the snapshot row count, and which
 * Auth-Keys are set. Freshness mirrors `PgFeedStore.probe` for self-fetch:
 * present iff a successful fetch has occurred (`last_fetched_at` set), stale
 * iff `now - last_fetched_at > maxAge`.
 */
export async function getSelfFetchSourceStatuses(
  pool: Pool,
  now: Date,
): Promise<SelfFetchSourceStatus[]> {
  const [stateRows, countRows, secretSet] = await Promise.all([
    pool
      .query<{
        source_policy_id: string;
        last_fetched_at: Date | null;
        last_attempt_at: Date | null;
        last_status: string | null;
        last_error: string | null;
        last_row_count: number | null;
      }>(
        `SELECT source_policy_id, last_fetched_at, last_attempt_at,
                last_status, last_error, last_row_count
           FROM feed_fetch_state`,
      )
      .then((r) => r.rows),
    pool
      .query<{ source_policy_id: string; row_count: string }>(
        `SELECT source_policy_id, COUNT(*)::text AS row_count
           FROM ioc_feed_snapshot GROUP BY source_policy_id`,
      )
      .then((r) => r.rows),
    feedSourceSecretStatus(pool),
  ]);

  const stateById = new Map(stateRows.map((r) => [r.source_policy_id, r]));
  const countById = new Map(
    countRows.map((r) => [r.source_policy_id, Number(r.row_count)]),
  );

  return TIER1_FEED_SOURCES.map((source) => {
    const state = stateById.get(source.sourcePolicyId);
    const lastFetchedAt = toIso(state?.last_fetched_at ?? null);
    const present = lastFetchedAt !== null;
    const stale =
      present &&
      now.getTime() - new Date(lastFetchedAt).getTime() > source.maxAge;
    // A vendor-repo source is fetchable too, but its GitHub token is OPTIONAL
    // (keyless works, rate-limited), so it is surfaced (name + set state) yet
    // never marked "required" the way a flat source's Auth-Key is.
    const authKeyName =
      source.fetch?.authKeyName ?? source.vendorRepo?.authKeyName ?? null;
    const authKeyRequired = source.fetch?.authKeyName != null;
    const vendorRepo = source.vendorRepo;
    const fetchable = source.fetch !== undefined || vendorRepo !== undefined;
    return {
      sourcePolicyId: source.sourcePolicyId,
      label: source.label,
      fetchable,
      unavailableReason: fetchable
        ? null
        : (source.selfFetchUnavailable ?? "fixture-only"),
      fetchUrl: source.fetch
        ? source.fetch.urls.join(", ")
        : vendorRepo
          ? `${vendorRepo.owner}/${vendorRepo.repo}@${vendorRepo.ref}`
          : null,
      authKeyRequired,
      authKeyName,
      authKeySet: authKeyName !== null && secretSet.has(authKeyName),
      present,
      stale,
      rowCount: countById.get(source.sourcePolicyId) ?? 0,
      lastFetchedAt,
      lastAttemptAt: toIso(state?.last_attempt_at ?? null),
      lastStatus: state?.last_status ?? null,
      lastError: state?.last_error ?? null,
      lastRowCount: state?.last_row_count ?? null,
    };
  });
}

/** Stable 32-bit advisory-lock key for a source (positive, non-zero). */
export function feedFetchLockKey(sourcePolicyId: string): number {
  const digest = createHash("sha256").update(sourcePolicyId).digest();
  // 31-bit unsigned keeps it a positive `int` (the lock's second arg).
  return (digest.readUInt32BE(0) & 0x7fffffff) | 1;
}

/** Outcome of a single-source self-fetch attempt (operator "Fetch Now"). */
export type SelfFetchOutcome =
  | { status: "imported"; rowCount: number }
  | { status: "not-modified" }
  | { status: "too-soon"; nextAllowedAt: string }
  | { status: "locked" }
  | { status: "error"; error: string };

export interface SelfFetchDeps {
  feedPool: Pool;
  transport?: FetchTransport;
  /** Resolve a secret's plaintext; defaults to the Transit-backed store. */
  resolveAuthKey?: (keyName: string) => Promise<string | null>;
  /** Clock (tests pin it); defaults to `() => new Date()`. */
  now?: () => Date;
  timeoutMs?: number;
}

async function httpGet(
  transport: FetchTransport,
  url: string,
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<FetchResponseLike> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await transport(url, { headers, signal: controller.signal });
  } catch (err) {
    throw new SelfFetchError(
      err instanceof Error ? err.message : "fetch failed",
    );
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The `self-fetch` `FeedSource` (#568). Holds the feed pool + injectable
 * transport/clock/auth-key resolver; `fetchAndImport` is the operator
 * "Fetch Now" path (single-flight + cadence floor + conditional GET +
 * replace-only import + `feed_fetch_state` recording).
 */
export class SelfFetchFeedSource {
  readonly mode: TiFeedMode = "self-fetch";

  private readonly feedPool: Pool;
  private readonly transport: FetchTransport;
  private readonly now: () => Date;
  private readonly timeoutMs: number;
  private readonly resolveAuthKey: (keyName: string) => Promise<string | null>;

  constructor(deps: SelfFetchDeps) {
    this.feedPool = deps.feedPool;
    this.transport = deps.transport ?? defaultTransport;
    this.now = deps.now ?? (() => new Date());
    this.timeoutMs = deps.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
    this.resolveAuthKey =
      deps.resolveAuthKey ??
      ((keyName) => readFeedSourceAuthKey(this.feedPool, keyName));
  }

  /**
   * The catalog source ids that can be self-fetched: a flat self-fetch config
   * (`fetch`, excludes EDROP) OR a vendor-repo config (`vendorRepo`), the latter
   * routed through the vendor-repo engine.
   */
  static fetchableSourceIds(): string[] {
    return TIER1_FEED_SOURCES.filter((s) => s.fetch || s.vendorRepo).map(
      (s) => s.sourcePolicyId,
    );
  }

  /**
   * Operator "Fetch Now" for ALL fetchable sources (best-effort): each runs
   * through `fetchAndImport` independently so one source's failure / 304 /
   * cadence-skip does not block the others.
   */
  async fetchAndImportAll(): Promise<
    { sourcePolicyId: string; outcome: SelfFetchOutcome }[]
  > {
    const out: { sourcePolicyId: string; outcome: SelfFetchOutcome }[] = [];
    for (const sourcePolicyId of SelfFetchFeedSource.fetchableSourceIds()) {
      out.push({
        sourcePolicyId,
        outcome: await this.fetchAndImport(sourcePolicyId),
      });
    }
    return out;
  }

  /**
   * Fetch + import ONE source. Single-flighted with a per-source advisory
   * lock (not acquired → `locked`, skip). Enforces the hard cadence floor
   * (within floor → `too-soon`, skip). Conditional GET against stored
   * validators: 304 → `not-modified` (snapshot untouched); 200 → replace via
   * `importRawFeedPayload` (a genuinely empty / comment-only feed is a
   * legitimate 0-row import, but a 200 carrying data that parses to zero rows
   * — an HTML error/block page or format drift — is rejected as a failure so
   * it cannot wipe the snapshot); failure → `error` (failure→stale,
   * `last_fetched_at` untouched).
   */
  async fetchAndImport(sourcePolicyId: string): Promise<SelfFetchOutcome> {
    const source = getTier1FeedSource(sourcePolicyId);
    if (!source?.fetch && !source?.vendorRepo) {
      return {
        status: "error",
        error: `Source "${sourcePolicyId}" is not configured for self-fetch`,
      };
    }

    const lockClient = await this.feedPool.connect();
    try {
      const lockKey = feedFetchLockKey(sourcePolicyId);
      const lockRes = await lockClient.query<{ locked: boolean }>(
        `SELECT pg_try_advisory_lock($1, $2) AS locked`,
        [FEED_FETCH_LOCK_NS, lockKey],
      );
      if (!lockRes.rows[0]?.locked) {
        return { status: "locked" };
      }
      try {
        // A vendor-repo source is imported through the vendor engine (tree
        // enumerate → allowlisted blobs → per-source batch replace), not the
        // flat conditional-GET path. The flat path takes precedence only if a
        // source somehow declared both.
        if (source.fetch) {
          return await this.runFetch(sourcePolicyId, source, source.fetch);
        }
        return await this.runVendorRepoFetch(
          sourcePolicyId,
          source,
          // Narrowed: reached only when `vendorRepo` is set and `fetch` is not.
          source.vendorRepo as VendorRepoConfig,
        );
      } finally {
        await lockClient
          .query(`SELECT pg_advisory_unlock($1, $2)`, [
            FEED_FETCH_LOCK_NS,
            lockKey,
          ])
          .catch(() => {});
      }
    } finally {
      lockClient.release();
    }
  }

  private async runFetch(
    sourcePolicyId: string,
    source: NonNullable<ReturnType<typeof getTier1FeedSource>>,
    fetchConfig: Tier1FetchConfig,
  ): Promise<SelfFetchOutcome> {
    // A streaming-decompress source (the URLhaus payloads ZIP) cannot be
    // buffered via `res.text()` — route it through the streaming path.
    if (fetchConfig.decompress) {
      return this.runStreamingFetch(sourcePolicyId, source, fetchConfig);
    }

    const now = this.now();
    const nowIso = now.toISOString();

    const state = await readFeedFetchState(this.feedPool, sourcePolicyId);
    if (withinCadenceFloor(state, fetchConfig.cadenceFloorMs, now)) {
      const allowed = nextFetchAllowedAt(state, fetchConfig.cadenceFloorMs);
      return {
        status: "too-soon",
        nextAllowedAt: (allowed ?? now).toISOString(),
      };
    }

    try {
      // Resolve the Auth-Key (if any) and build the real request URL(s).
      // `resolveFetchUrls` embeds the key in the URL path; the provenance
      // origin below uses the PLACEHOLDER template so the secret is never
      // persisted to `ioc_feed_snapshot`.
      let authKey: string | null = null;
      if (fetchConfig.authKeyName) {
        authKey = await this.resolveAuthKey(fetchConfig.authKeyName);
      }
      const urls = resolveFetchUrls(fetchConfig, authKey);

      // Conditional GET only when there is a single URL: a multi-URL source
      // (Spamhaus v4 + v6) has no single ETag to revalidate against, so it is
      // always fetched in full.
      const conditional = urls.length === 1 ? conditionalGetHeaders(state) : {};

      const bodies: string[] = [];
      let etag: string | null = null;
      let lastModified: string | null = null;
      for (const url of urls) {
        const res = await httpGet(
          this.transport,
          url,
          conditional,
          this.timeoutMs,
        );
        if (res.status === 304) {
          // Only reachable for the single-URL conditional case.
          await recordNotModified(this.feedPool, sourcePolicyId, nowIso);
          return { status: "not-modified" };
        }
        if (!res.ok) {
          throw new SelfFetchError(`HTTP ${res.status}`);
        }
        bodies.push(await res.text());
        etag = etag ?? res.headers.get("etag");
        lastModified = lastModified ?? res.headers.get("last-modified");
      }

      const content = bodies.join("\n");

      // Guard against an upstream HTML error/block page or a format drift that
      // arrives with a 200: the lenient parsers would silently drop it to zero
      // rows, and the replace-only import would then DELETE the good snapshot
      // and mark the source fresh+empty. Reject "data lines but zero parsed
      // rows" as a failure (→ failure→stale: snapshot + last_fetched_at left
      // untouched), while still allowing a genuinely empty / comment-only feed
      // (e.g. Feodo) to legitimately clear the source.
      if (
        isUnparseableFeedContent(
          fetchConfig.parse,
          source.entityType,
          content,
          fetchConfig.parseConfig,
        )
      ) {
        throw new SelfFetchError(
          "Fetched response has data but no recognizable feed entries " +
            "(possible upstream error/block page or format drift)",
        );
      }

      const payload: RawFeedPayload = {
        sourcePolicyId,
        parse: fetchConfig.parse,
        parseConfig: fetchConfig.parseConfig,
        entityType: source.entityType,
        polarity: source.polarity,
        hitType: source.hitType,
        classification: source.classification,
        content,
        provenance: {
          mode: "self-fetch",
          origin: fetchConfig.urls.join(", "),
          sourceUpdatedAt: nowIso,
        },
      };
      const { rowCount } = await importRawFeedPayload(this.feedPool, payload);
      await recordOk(this.feedPool, sourcePolicyId, {
        nowIso,
        etag,
        lastModified,
        rowCount,
      });
      return { status: "imported", rowCount };
    } catch (err) {
      const message = err instanceof Error ? err.message : "self-fetch failed";
      await recordError(this.feedPool, sourcePolicyId, nowIso, message);
      return { status: "error", error: message };
    }
  }

  /**
   * Fetch + import ONE streaming-decompress source (the URLhaus payloads ZIP,
   * #657). Same single-flight lock (held by the caller) + hard cadence floor +
   * conditional GET + failure→stale recording as the flat path, but the body is
   * a ZIP archive whose single inner CSV decompresses to ~2.6 GB — past Node's
   * max string — so it is NEVER buffered: the body is consumed as a stream
   * (ZIP-inflate → line parse → `importFeedSnapshotStreaming`'s staging-table
   * replace). The timeout is scoped over the WHOLE stream/body consumption (not
   * just the header handshake) and uses the source's long per-source `timeoutMs`
   * so a legitimately slow multi-hundred-MB fetch is not killed while a stalled
   * stream is still bounded. The zero-row guard lives in the streaming import
   * (data lines but zero parsed rows → fail before any DELETE), preserving
   * failure→stale.
   */
  private async runStreamingFetch(
    sourcePolicyId: string,
    source: NonNullable<ReturnType<typeof getTier1FeedSource>>,
    fetchConfig: Tier1FetchConfig,
  ): Promise<SelfFetchOutcome> {
    const now = this.now();
    const nowIso = now.toISOString();

    const state = await readFeedFetchState(this.feedPool, sourcePolicyId);
    if (withinCadenceFloor(state, fetchConfig.cadenceFloorMs, now)) {
      const allowed = nextFetchAllowedAt(state, fetchConfig.cadenceFloorMs);
      return {
        status: "too-soon",
        nextAllowedAt: (allowed ?? now).toISOString(),
      };
    }

    const timeoutMs = fetchConfig.timeoutMs ?? this.timeoutMs;
    try {
      let authKey: string | null = null;
      if (fetchConfig.authKeyName) {
        authKey = await this.resolveAuthKey(fetchConfig.authKeyName);
      }
      const urls = resolveFetchUrls(fetchConfig, authKey);
      if (urls.length !== 1) {
        throw new SelfFetchError(
          "a streaming-decompress source must have exactly one URL",
        );
      }
      const url = urls[0];
      const conditional = conditionalGetHeaders(state);

      // Scope the timeout over the WHOLE body consumption, not just the header
      // handshake: the timer is cleared only after the stream is fully imported
      // (or fails), so a stalled multi-hundred-MB download is still bounded.
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        let res: FetchResponseLike;
        try {
          res = await this.transport(url, {
            headers: conditional,
            signal: controller.signal,
          });
        } catch (err) {
          throw new SelfFetchError(
            err instanceof Error ? err.message : "fetch failed",
          );
        }
        if (res.status === 304) {
          await recordNotModified(this.feedPool, sourcePolicyId, nowIso);
          return { status: "not-modified" };
        }
        if (!res.ok) {
          throw new SelfFetchError(`HTTP ${res.status}`);
        }
        if (!res.body) {
          throw new SelfFetchError("Fetched response has no body stream");
        }
        const etag = res.headers.get("etag");
        const lastModified = res.headers.get("last-modified");

        const nodeBody = Readable.fromWeb(
          res.body as NodeWebReadableStream<Uint8Array>,
        );
        const decompressed =
          fetchConfig.decompress === "zip"
            ? openSingleZipEntry(nodeBody)
            : nodeBody;
        const { rowCount } = await importFeedSnapshotStreaming(this.feedPool, {
          sourcePolicyId,
          entityType: source.entityType,
          polarity: source.polarity,
          hitType: source.hitType,
          classification: source.classification,
          sourceUpdatedAt: nowIso,
          lines: readLines(decompressed),
          extractValues: streamingLineExtractor(fetchConfig.parse),
        });
        await recordOk(this.feedPool, sourcePolicyId, {
          nowIso,
          etag,
          lastModified,
          rowCount,
        });
        return { status: "imported", rowCount };
      } finally {
        clearTimeout(timer);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "self-fetch failed";
      await recordError(this.feedPool, sourcePolicyId, nowIso, message);
      return { status: "error", error: message };
    }
  }

  /**
   * Fetch + import ONE vendor-repo source through the vendor-repo engine. Same
   * single-flight lock (held by the caller) + hard cadence floor + failure→stale
   * recording as the flat path, but the body is a tree-enumerate → allowlisted
   * blob fetch → per-source batch replace rather than a conditional GET:
   *
   *   - The optional GitHub token is resolved from the `feed_source_secret`
   *     envelope (via the injected resolver) and passed to the live provider;
   *     keyless still works (rate-limited). The token is never logged.
   *   - There is no conditional GET / ETag (a repo is many blobs, not one file),
   *     so every due fetch enumerates the tree afresh.
   *   - Low IOC yield is tolerated (a Huntress-style rule-heavy repo may import
   *     few or zero rows) — unlike the flat path, an empty result is NOT an
   *     error. The engine collects all rows BEFORE the single
   *     `importFeedSnapshot` replace, so a network failure mid-enumeration
   *     throws before any DELETE and the good snapshot is left intact
   *     (failure→stale).
   */
  private async runVendorRepoFetch(
    sourcePolicyId: string,
    source: NonNullable<ReturnType<typeof getTier1FeedSource>>,
    vendorRepo: VendorRepoConfig,
  ): Promise<SelfFetchOutcome> {
    const now = this.now();
    const nowIso = now.toISOString();

    const cadenceFloorMs =
      vendorRepo.cadenceFloorMs ?? VENDOR_REPO_DEFAULT_CADENCE_FLOOR_MS;
    const state = await readFeedFetchState(this.feedPool, sourcePolicyId);
    if (withinCadenceFloor(state, cadenceFloorMs, now)) {
      const allowed = nextFetchAllowedAt(state, cadenceFloorMs);
      return {
        status: "too-soon",
        nextAllowedAt: (allowed ?? now).toISOString(),
      };
    }

    try {
      const token = vendorRepo.authKeyName
        ? await this.resolveAuthKey(vendorRepo.authKeyName)
        : null;
      const provider = new LiveVendorRepoProvider(vendorRepo, {
        token,
        transport: this.transport,
        timeoutMs: this.timeoutMs,
      });
      const input: VendorRepoCollectInput = {
        sourcePolicyId,
        entityType: source.entityType,
        hitType: source.hitType,
        classification: source.classification,
        vendorRepo,
        sourceUpdatedAt: nowIso,
      };
      const { rowCount } = await importVendorRepo(
        this.feedPool,
        provider,
        input,
      );
      await recordOk(this.feedPool, sourcePolicyId, {
        nowIso,
        etag: null,
        lastModified: null,
        rowCount,
      });
      return { status: "imported", rowCount };
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "vendor-repo fetch failed";
      await recordError(this.feedPool, sourcePolicyId, nowIso, message);
      return { status: "error", error: message };
    }
  }
}
