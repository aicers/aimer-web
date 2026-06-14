// RFC 0003 F4 (#603) — vendor-repo IOC importer engine + guards.
//
// Appendix A clears seven vendor IOC repositories (Unit 42, ESET, Volexity,
// PRODAFT, Zscaler, Huntress, Meta) for first-party use — the first source of
// C1 narrative context (indicators bundled with report-level actor / campaign /
// malware-family / blog link). Unlike a flat Tier-1 feed (one file fetched
// directly), a vendor repo is a Git tree of per-report folders with
// heterogeneous formats, and several carry ingestion hazards (PRODAFT ships
// live `.exe` malware samples, Meta is mostly CIB / influence-ops, Huntress is
// ~90% Sigma/YARA rule files, all defang their IOCs).
//
// This engine is the foundation the seven per-repo descriptors plug into. It:
//   - enumerates a repo tree via the Git tree API (paths/types only),
//   - fetches ONLY the blobs that pass the per-repo allowlist — never the full
//     repo archive (a tarball/zip would land binary bytes on disk),
//   - dispatches per-file extraction (CSV / one-per-line list / prose
//     free-text) reusing the F3 parsers + refang,
//   - captures report context from the file path and threads it onto each row,
//   - enforces the guards CENTRALLY: binary/rule-file skip (enforce-by-default
//     allowlist), and the CIB downgrade (`deterministicAllowed: false` →
//     `soft_reputation`, regardless of what a file declared),
//   - aggregates every allowlisted file's rows into ONE snapshot replace per
//     `source_policy_id` (a per-file replace would clobber all but the last).
//
// The seven per-repo descriptors/fixtures are the fan-out (each a self-contained
// issue: repo URL + allowlist + context-extraction config + pinned fixture).

import "server-only";

import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import type { Pool } from "pg";
import {
  type FetchResponseLike,
  type FetchTransport,
  readFeedSourceAuthKey,
} from "./feed-fetch";
import {
  type FeedSnapshotRow,
  importFeedSnapshot,
  parseRawFeedPayloadRows,
} from "./feed-import";
import type {
  RawFeedPayload,
  TiFeedMode,
  VendorRepoConfig,
  VendorRepoFileRule,
} from "./feed-source";
import type { EnrichmentContextPayload } from "./types";

// ---------------------------------------------------------------------------
// Tree provider seam (live GitHub API / committed fixture tree)
// ---------------------------------------------------------------------------

/** One entry of a repo tree listing — path + type only (no bytes). */
export interface VendorRepoTreeEntry {
  /** Repo-relative POSIX path. */
  path: string;
  /** `blob` (file) or `tree` (directory). */
  type: "blob" | "tree";
}

/**
 * Yields a vendor repo's tree (paths/types) and the bytes of an INDIVIDUAL
 * allowlisted blob. The engine never asks for a non-allowlisted path, so a
 * binary (`.exe`) is never read; `readBlob` is the ONLY byte-fetch path (there
 * is deliberately no full-archive method).
 */
export interface VendorRepoProvider {
  /** The supply mode this provider sources bytes from (audit provenance). */
  readonly mode: TiFeedMode;
  /** List the tree (paths + types only). */
  listTree(): Promise<VendorRepoTreeEntry[]>;
  /** Fetch one blob's UTF-8 text by repo-relative path. */
  readBlob(path: string): Promise<string>;
}

// ---------------------------------------------------------------------------
// Allowlist + context extraction (pure)
// ---------------------------------------------------------------------------

/**
 * The first file rule whose `pathPattern` matches `path`, or `undefined` when
 * the path is not allowlisted (the enforce-by-default skip: binaries, rule
 * files, excluded CIB folders all return `undefined` and are never fetched).
 */
export function matchVendorFileRule(
  path: string,
  config: VendorRepoConfig,
): VendorRepoFileRule | undefined {
  return config.files.find((rule) => new RegExp(rule.pathPattern).test(path));
}

/** Substitute `{name}` tokens in a template from a flat string map. */
function substituteTemplate(
  template: string,
  values: Record<string, string>,
): string {
  return template.replace(/\{(\w+)\}/g, (whole, name: string) =>
    Object.hasOwn(values, name) ? values[name] : whole,
  );
}

/**
 * Derive the report-level context (`actor` / `campaign` / `malwareFamily` /
 * `reportUrl`) for a file from its path, per the repo's `contextPattern` named
 * captures, `reportUrlTemplate`, and static `context` defaults. Path-derived
 * captures win over the static defaults. Returns `undefined` when no usable
 * context survives (so a context-less file leaves the row's `context` absent).
 */
export function deriveVendorContext(
  path: string,
  config: VendorRepoConfig,
): EnrichmentContextPayload | undefined {
  const context: EnrichmentContextPayload = {};
  if (config.context?.actor) context.actor = config.context.actor;
  if (config.context?.campaign) context.campaign = config.context.campaign;
  if (config.context?.malwareFamily) {
    context.malwareFamily = config.context.malwareFamily;
  }

  const captures: Record<string, string> = {};
  if (config.contextPattern) {
    const groups = new RegExp(config.contextPattern).exec(path)?.groups;
    if (groups) {
      for (const [key, value] of Object.entries(groups)) {
        if (value !== undefined) captures[key] = value;
      }
      if (captures.actor) context.actor = captures.actor;
      if (captures.campaign) context.campaign = captures.campaign;
      if (captures.malwareFamily)
        context.malwareFamily = captures.malwareFamily;
    }
  }

  if (config.reportUrlTemplate) {
    context.reportUrl = substituteTemplate(config.reportUrlTemplate, {
      ...captures,
      path,
      owner: config.owner,
      repo: config.repo,
      ref: config.ref,
    });
  }

  return Object.keys(context).length > 0 ? context : undefined;
}

/** Human-readable origin pointer for a vendor-repo file (audit). */
function vendorRepoOrigin(config: VendorRepoConfig, path: string): string {
  return `${config.owner}/${config.repo}@${config.ref}:${path}`;
}

// ---------------------------------------------------------------------------
// Collect rows across the repo (the per-source batch)
// ---------------------------------------------------------------------------

/** Inputs the engine needs beyond the descriptor's vendor-repo config. */
export interface VendorRepoCollectInput {
  sourcePolicyId: string;
  /** Default entity type for the snapshot (per-row/per-token types override). */
  entityType: RawFeedPayload["entityType"];
  /** Source-default hit type (a per-file rule / the CIB guard may override). */
  hitType: RawFeedPayload["hitType"];
  classification?: string;
  vendorRepo: VendorRepoConfig;
  sourceVersion?: string;
  sourceUpdatedAt?: string;
}

/** The aggregated outcome of walking a repo (before the snapshot replace). */
export interface VendorRepoCollectResult {
  /** Context-stamped, guard-stamped rows from every allowlisted file. */
  rows: FeedSnapshotRow[];
  /** Repo-relative paths that were fetched + parsed (allowlisted blobs). */
  fetched: string[];
  /** Blob paths skipped by the allowlist (binaries, rule files, CIB folders). */
  skipped: string[];
}

/**
 * Walk a repo's tree, fetch ONLY allowlisted blobs, extract + context-stamp +
 * guard-stamp each file's rows, and aggregate them. Does NOT import — the
 * caller does the single per-source replace, so a multi-file repo lands in one
 * snapshot (no last-file-wins clobber). A blob matching no rule is skipped
 * (never fetched), so a `.exe` / rule file / CIB folder never has its bytes
 * read. Low IOC yield is tolerated (a prose note with zero IOCs is not an
 * error) — the rows simply do not grow.
 */
export async function collectVendorRepoRows(
  provider: VendorRepoProvider,
  input: VendorRepoCollectInput,
): Promise<VendorRepoCollectResult> {
  const config = input.vendorRepo;
  const entries = await provider.listTree();
  const rows: FeedSnapshotRow[] = [];
  const fetched: string[] = [];
  const skipped: string[] = [];

  for (const entry of entries) {
    if (entry.type !== "blob") continue;
    const rule = matchVendorFileRule(entry.path, config);
    if (!rule) {
      skipped.push(entry.path);
      continue;
    }

    const content = await provider.readBlob(entry.path);
    fetched.push(entry.path);

    const deterministicAllowed =
      rule.deterministicAllowed ?? config.deterministicAllowed ?? true;
    const payload: RawFeedPayload = {
      sourcePolicyId: input.sourcePolicyId,
      parse: rule.parse,
      parseConfig: rule.parseConfig,
      entityType: rule.entityType,
      hitType: rule.hitType ?? input.hitType,
      classification: rule.classification ?? input.classification,
      context: deriveVendorContext(entry.path, config),
      deterministicAllowed,
      content,
      provenance: {
        mode: provider.mode,
        origin: vendorRepoOrigin(config, entry.path),
        sourceUpdatedAt: input.sourceUpdatedAt,
      },
    };

    const fileRows = parseRawFeedPayloadRows(payload);
    for (const row of fileRows) {
      // A vendor repo mixes entity types across files under ONE source, so a
      // row that did not self-classify (a `generic-list` file emits bare
      // `match_value`s) must carry its file's entity type explicitly — the
      // snapshot-level default is for whatever the rest of the repo is, not
      // this file. Self-classifying parsers (`csv-column` / `free-text`)
      // already stamped a per-token type, so this only fills the gap.
      if (row.entityType === undefined) row.entityType = rule.entityType;
      // A file rule may declare a hit type / classification that differs from
      // the source default; carry it as a per-row override so the single
      // source-level snapshot can hold rows of more than one hit type (the
      // guard above still forces `soft_reputation` for a
      // `deterministicAllowed: false` file).
      if (rule.hitType !== undefined && rule.hitType !== input.hitType) {
        row.hitType = rule.hitType;
      }
      if (
        rule.classification !== undefined &&
        rule.classification !== input.classification
      ) {
        row.classification = rule.classification;
      }
    }
    rows.push(...fileRows);
  }

  return { rows, fetched, skipped };
}

// ---------------------------------------------------------------------------
// Import (one snapshot replace per source)
// ---------------------------------------------------------------------------

/** Outcome of a vendor-repo import (audit). */
export interface VendorRepoImportResult {
  rowCount: number;
  feedHash: string;
  fetched: string[];
  skipped: string[];
}

/**
 * Import a vendor repo into `ioc_feed_snapshot`: collect every allowlisted
 * file's rows, then do a SINGLE `importFeedSnapshot` replace for the source.
 * This is the critical seam constraint — `importFeedSnapshot` is replace-all
 * per `source_policy_id`, so the many files of one repo must be aggregated into
 * one replace (never a per-file replace loop, which would keep only the last
 * file). The CIB guard is enforced inside `importFeedSnapshot` (a
 * `deterministicAllowed: false` row is forced to `soft_reputation`).
 */
export async function importVendorRepo(
  pool: Pool,
  provider: VendorRepoProvider,
  input: VendorRepoCollectInput,
): Promise<VendorRepoImportResult> {
  const { rows, fetched, skipped } = await collectVendorRepoRows(
    provider,
    input,
  );
  const { rowCount, feedHash } = await importFeedSnapshot(pool, {
    sourcePolicyId: input.sourcePolicyId,
    entityType: input.entityType,
    hitType: input.hitType,
    classification: input.classification,
    sourceVersion: input.sourceVersion,
    sourceUpdatedAt: input.sourceUpdatedAt,
    rows,
  });
  return { rowCount, feedHash, fetched, skipped };
}

// ---------------------------------------------------------------------------
// Fixture provider (committed tree, offline — no GitHub calls in CI)
// ---------------------------------------------------------------------------

/**
 * Reads a committed sample repo tree from disk so tests run offline. Records
 * every path `readBlob` was asked for (`readPaths`) so a test can assert a
 * binary sentinel (`sample.exe`) was NEVER fetched.
 */
export class FixtureVendorRepoProvider implements VendorRepoProvider {
  readonly mode: TiFeedMode = "fixture";
  /** Every repo-relative path `readBlob` was called with (assertion hook). */
  readonly readPaths: string[] = [];

  constructor(private readonly rootDir: string) {}

  async listTree(): Promise<VendorRepoTreeEntry[]> {
    return walkFixtureTree(this.rootDir, this.rootDir);
  }

  async readBlob(path: string): Promise<string> {
    this.readPaths.push(path);
    return readFileSync(join(this.rootDir, path), "utf8");
  }
}

/** Recursively list a fixture dir as repo-relative POSIX tree entries. */
function walkFixtureTree(root: string, dir: string): VendorRepoTreeEntry[] {
  const out: VendorRepoTreeEntry[] = [];
  for (const dirent of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, dirent.name);
    const rel = relative(root, abs).split(sep).join("/");
    if (dirent.isDirectory()) {
      out.push({ path: rel, type: "tree" });
      out.push(...walkFixtureTree(root, abs));
    } else if (dirent.isFile()) {
      out.push({ path: rel, type: "blob" });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Live provider (GitHub Git Data API — tree + blob, optional token)
// ---------------------------------------------------------------------------

/** GitHub API base — overridable for tests (never hit live in CI). */
export const GITHUB_API_BASE = "https://api.github.com";

const defaultTransport: FetchTransport = (url, init) =>
  fetch(url, { method: "GET", headers: init.headers, signal: init.signal });

/** A vendor-repo fetch failure (network / non-2xx / decode). */
export class VendorRepoFetchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VendorRepoFetchError";
  }
}

export interface LiveVendorRepoDeps {
  /** Optional GitHub token (lifts 60→5000 req/hr). Keyless still works. */
  token?: string | null;
  transport?: FetchTransport;
  timeoutMs?: number;
  apiBase?: string;
}

/**
 * Live GitHub provider. Enumerates the tree via the Git Data tree API
 * (`/git/trees/{ref}?recursive=1`, paths/types only) and fetches each
 * allowlisted blob via the Git Data blob API (`/git/blobs/{sha}`, base64),
 * keyed by the SHA the tree listing returned. There is NO archive (tarball /
 * zipball) path — fetching an archive would pull a repo's binary bytes onto
 * disk, violating the "never fetch binaries" guard. An optional GitHub token is
 * sent as `Authorization: Bearer …`; it is never logged. Keyless requests still
 * work (subject to the 60 req/hr ceiling).
 */
export class LiveVendorRepoProvider implements VendorRepoProvider {
  readonly mode: TiFeedMode = "self-fetch";

  private readonly token: string | null;
  private readonly transport: FetchTransport;
  private readonly timeoutMs: number;
  private readonly apiBase: string;
  /** `path → blob sha`, populated by `listTree` for `readBlob` to resolve. */
  private readonly shaByPath = new Map<string, string>();

  constructor(
    private readonly config: VendorRepoConfig,
    deps: LiveVendorRepoDeps = {},
  ) {
    this.token = deps.token ?? null;
    this.transport = deps.transport ?? defaultTransport;
    this.timeoutMs = deps.timeoutMs ?? 30_000;
    this.apiBase = deps.apiBase ?? GITHUB_API_BASE;
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    return headers;
  }

  private async getJson<T>(url: string): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res: FetchResponseLike;
    try {
      res = await this.transport(url, {
        headers: this.headers(),
        signal: controller.signal,
      });
    } catch (err) {
      throw new VendorRepoFetchError(
        err instanceof Error ? err.message : "fetch failed",
      );
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) throw new VendorRepoFetchError(`HTTP ${res.status}`);
    return JSON.parse(await res.text()) as T;
  }

  async listTree(): Promise<VendorRepoTreeEntry[]> {
    const { owner, repo, ref } = this.config;
    const url =
      `${this.apiBase}/repos/${owner}/${repo}/git/trees/` +
      `${encodeURIComponent(ref)}?recursive=1`;
    const body = await this.getJson<{
      tree?: { path?: string; type?: string; sha?: string }[];
    }>(url);
    const entries: VendorRepoTreeEntry[] = [];
    for (const node of body.tree ?? []) {
      if (!node.path) continue;
      if (node.type === "blob") {
        if (node.sha) this.shaByPath.set(node.path, node.sha);
        entries.push({ path: node.path, type: "blob" });
      } else if (node.type === "tree") {
        entries.push({ path: node.path, type: "tree" });
      }
    }
    return entries;
  }

  async readBlob(path: string): Promise<string> {
    const sha = this.shaByPath.get(path);
    if (!sha) {
      throw new VendorRepoFetchError(
        `no blob sha for "${path}" (listTree must run first)`,
      );
    }
    const { owner, repo } = this.config;
    const body = await this.getJson<{ content?: string; encoding?: string }>(
      `${this.apiBase}/repos/${owner}/${repo}/git/blobs/${sha}`,
    );
    if (body.encoding === "base64" && body.content) {
      return Buffer.from(body.content, "base64").toString("utf8");
    }
    return body.content ?? "";
  }
}

/**
 * Resolve the optional GitHub token for a vendor repo from the
 * `feed_source_secret` envelope (the same write-only Transit-backed store as
 * the URLhaus Auth-Key / NVD key). Returns `null` when the repo declares no
 * `authKeyName` or none is set — keyless fetch still works (rate-limited).
 */
export async function resolveVendorRepoToken(
  pool: Pool,
  config: VendorRepoConfig,
): Promise<string | null> {
  if (!config.authKeyName) return null;
  return readFeedSourceAuthKey(pool, config.authKeyName);
}
