// RFC 0003 Tier-1 feed-refresh (#564) — the `FeedSource` adapter seam.
//
// A `FeedSource` yields the RAW feed payload(s) + provenance for a supply
// mode — the source-specific *origin* of the bytes (a committed fixture
// file, an admin upload, an HTTP response). It does NOT parse or
// normalize: the `parse*` / `normalize*` / `importFeedSnapshot` pipeline
// in `feed-import.ts` is the common downstream that turns a raw payload
// from ANY source into `ioc_feed_snapshot` rows uniformly.
//
// So a "mode" = WHERE the raw feed comes from; everything after the raw
// bytes is shared. `fixture` (part 1) and `manual-upload` (part 2, #566)
// are implemented. Note that `manual-upload` is NOT a pull-based
// `FeedSource`: the admin upload route builds a `RawFeedPayload` and calls
// the common downstream (`importRawFeedPayload`) directly, so it never goes
// through the mode→`FeedSource` dispatch. The pull-based `FeedSource` seam
// is reserved for parts 3-4 (`self-fetch` / `managed`), which add their
// implementations without re-plumbing the downstream.

import type { EntityType, HitType, SourcePolarity } from "./types";

/**
 * Deployment-level TI feed supply mode (`TI_FEED_MODE`). The value space is
 * fixed here so the later parts slot in without re-plumbing; parts 1-2
 * (`fixture`, `manual-upload`) are implemented.
 */
export type TiFeedMode = "fixture" | "manual-upload" | "self-fetch" | "managed";

/** Every defined supply mode, in series order. */
export const TI_FEED_MODES: readonly TiFeedMode[] = [
  "fixture",
  "manual-upload",
  "self-fetch",
  "managed",
];

/** Supply modes implemented in this part of the series. */
export const SUPPORTED_TI_FEED_MODES: readonly TiFeedMode[] = [
  "fixture",
  "manual-upload",
  "self-fetch",
];

/** Default mode when `TI_FEED_MODE` is unset. */
export const DEFAULT_TI_FEED_MODE: TiFeedMode = "fixture";

/**
 * Resolve the deployment's TI feed mode from `TI_FEED_MODE` (defaulting to
 * `fixture`). Throws on an unknown value, or on a defined-but-not-yet
 * -implemented mode (parts 3-4: `self-fetch` / `managed`), so a
 * misconfiguration fails fast rather than silently importing nothing.
 */
export function resolveTiFeedMode(
  value: string | undefined = process.env.TI_FEED_MODE,
): TiFeedMode {
  if (value === undefined || value === "") {
    return DEFAULT_TI_FEED_MODE;
  }
  if (!TI_FEED_MODES.includes(value as TiFeedMode)) {
    throw new Error(
      `Unknown TI_FEED_MODE "${value}" (expected one of: ${TI_FEED_MODES.join(", ")})`,
    );
  }
  const mode = value as TiFeedMode;
  if (!SUPPORTED_TI_FEED_MODES.includes(mode)) {
    throw new Error(
      `TI_FEED_MODE "${mode}" is defined but not yet implemented ` +
        `(supported: ${SUPPORTED_TI_FEED_MODES.join(", ")})`,
    );
  }
  return mode;
}

/**
 * Which parser turns a raw feed payload's published format into indicator
 * values. Intrinsic to the source policy (Feodo is `ip-blocklist`, URLhaus
 * is `urlhaus-csv`, …) — independent of the supply mode, so every
 * `FeedSource` tags its payloads with the right kind for the common
 * downstream to dispatch on.
 */
export type FeedParseKind =
  | "ip-blocklist"
  | "urlhaus-csv"
  | "urlhaus-payloads-csv"
  | "spamhaus-drop"
  // Spamhaus DROP/DROPv6 as published over HTTP today: NDJSON (one JSON
  // object per line), distinct from the legacy `<CIDR> ; <SBLref>` text
  // form (`spamhaus-drop`) the fixtures / manual uploads still use.
  | "spamhaus-drop-ndjson";

/**
 * Where a raw payload's bytes came from, recorded for audit / freshness.
 * `sourceUpdatedAt` stamps the snapshot's freshness (drives stale-coverage
 * policy); `origin` is a human-readable pointer (file path, upload id, URL).
 */
export interface FeedProvenance {
  /** Supply mode that produced this payload. */
  mode: TiFeedMode;
  /** Human-readable origin of the bytes (file path / upload id / URL). */
  origin: string;
  /** ISO timestamp of the payload's freshness, if known. */
  sourceUpdatedAt?: string;
  /** Source-declared version string, if any. */
  sourceVersion?: string;
}

/**
 * A raw, UNPARSED feed payload yielded by a `FeedSource`, plus the metadata
 * the common downstream needs to parse + import it. `content` is the origin
 * bytes verbatim (no parsing/normalization); `parse` / `entityType` /
 * `hitType` / `classification` describe how to turn it into snapshot rows.
 */
export interface RawFeedPayload {
  /** Source policy this payload populates (e.g. `abuse.ch/feodo`). */
  sourcePolicyId: string;
  /** How to parse `content` into indicator values. */
  parse: FeedParseKind;
  /** Default entity type for the parsed rows. */
  entityType: EntityType;
  /**
   * Source polarity (RFC 0003 F5, #599). Omitted ⇒ `positive`. A `negative`
   * payload imports its rows as negative (with `hit_type` NULL); the descriptor
   * `polarity` reaches the rows through this field across every supply mode.
   */
  polarity?: SourcePolarity;
  /**
   * Intrinsic match type — Tier-1 IOC feeds are `deterministic_ioc`. Present
   * for a positive payload; OMITTED for a `negative` payload (its rows carry
   * no `hit_type`).
   */
  hitType?: HitType;
  /** Optional classification tag for the rows. */
  classification?: string;
  /** Raw feed content as published by the origin — NOT parsed. */
  content: string;
  /** Origin provenance (audit + freshness). */
  provenance: FeedProvenance;
}

/**
 * A source of raw feed payloads for the supply pipeline. Implementations
 * yield origin bytes + provenance only — parsing, normalization, and import
 * are the shared downstream (`importFromFeedSource` in `feed-import.ts`).
 */
export interface FeedSource {
  /** The supply mode this source implements. */
  readonly mode: TiFeedMode;
  /** Yield the raw payloads for this source (no parsing/normalization). */
  loadPayloads(): Promise<RawFeedPayload[]>;
}
