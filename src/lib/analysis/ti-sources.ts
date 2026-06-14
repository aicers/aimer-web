// Per-customer/group TI source selection (RFC 0003 F2, #598).
//
// Enrichment used to be GLOBAL — every customer was enriched against every
// registered Tier-1 source. This module introduces the first per-subject
// scoping: a per-subject (customer or group) ALLOWLIST of which sources
// enrichment runs against, resolved through the same three-tier order as
// `default-model.ts`:
//
//   1. per-subject selection — `subject_ti_sources` row
//   2. admin-set global      — `system_settings.ti_sources_default`
//   3. built-in default      — ALL registered sources enabled
//
// Storage is an ALLOWLIST keyed on the live source registry
// (`allTiSourceDescriptors()`, #588): the ABSENCE of a row means "all
// sources enabled" (so there is no behavior change until a subject is
// narrowed); a PRESENT row is authoritative (a source not listed is
// disabled, including one registered after the row was written). A present
// row must enable >=1 source — an empty selection is rejected at write
// because the coverage model would report a vacuous `complete` over an
// empty registry (see the issue's design decisions / `coverage.ts`).
//
// The resolver is DEFENSIVE at every DB tier exactly as `default-model.ts`:
// a stored value may drift from the live registry (a source unregistered, or
// a hand-edited row). Unknown `sourcePolicyId`s are dropped and logged; a
// tier whose live intersection is EMPTY is treated as stale and falls
// through to the next tier rather than handing enrichment an empty registry.
// The all-enabled built-in tier is the trusted base and is never empty.
//
// v1 is customer-only at the management/route layer (group selection lands
// with #542), but the table, this resolver, permissions, and audit are all
// subject-generic and store rows for either subject kind.
//
// SERVER-ONLY. Reads the auth DB and the (server-only) source registry.

import "server-only";

import type { Pool, PoolClient } from "pg";
import { auditLog } from "../audit";
import { assertAuthorized } from "../auth/authorization";
import { HttpError } from "../auth/errors";
import { getAuthPool } from "../db/client";
// Importing the barrel runs every source's `registerTiSource` side effect, so
// the registry is populated before this module enumerates it.
import "./enrichment/sources";
import { allTiSourceDescriptors } from "./enrichment/sources/registry";
import type { EntityType } from "./enrichment/types";

/** `system_settings` key holding the admin-set global default selection. */
export const GLOBAL_TI_SOURCES_DEFAULT_KEY = "ti_sources_default";

/** Permission keys gating per-subject TI-source read/write (#598). */
const PERM_READ = "ti-sources:read";
const PERM_WRITE = "ti-sources:write";

// A Pool or a checked-out PoolClient — both expose `.query`.
type Queryable = Pool | PoolClient;

/**
 * One selectable source as exposed to the management UI. A deliberately
 * NARROW public DTO: it carries ONLY what the toggle UI needs and never the
 * internal descriptor fields (`parse`, `fetch.urls`, `fixtureFile`,
 * `hitType`, `maxAge`, …), which describe feed-fetch/parse internals.
 */
export interface TiSourceCatalogEntry {
  sourcePolicyId: string;
  label: string;
  entityTypes: EntityType[];
  /** Whether this source is enabled under the resolved/effective selection. */
  enabled: boolean;
  /**
   * RFC 0003 F2 Tier-2 seam (#598): `true` for a source that would require a
   * customer-supplied paid key (distinct from the operator-side fetch
   * Auth-Key). No source sets it today — it is a shape placeholder so the UI
   * can render such a source as unavailable-without-key once Tier 2 lands.
   */
  requiresCustomerKey: boolean;
}

function logResolverEvent(
  event: string,
  subjectId: string,
  detail: Record<string, unknown>,
): void {
  console.warn(
    JSON.stringify({
      level: "warn",
      event: `analysis.ti_sources.${event}`,
      subject_id: subjectId,
      ...detail,
    }),
  );
}

/** Live source-id set from the registry (the trusted base for intersection). */
function liveSourceIdSet(): Set<string> {
  return new Set(allTiSourceDescriptors().map((d) => d.sourcePolicyId));
}

/**
 * Every registered source id, sorted — the built-in "all enabled" default
 * (third tier) and the floor the resolver is guaranteed never to return empty.
 */
export function allEnabledSourceIds(): string[] {
  return allTiSourceDescriptors()
    .map((d) => d.sourcePolicyId)
    .sort();
}

/**
 * The selectable catalog as the public DTO, each entry flagged `enabled`
 * against `enabledIds`. Never leaks internal descriptor fields.
 */
export function toCatalogDto(
  enabledIds: Iterable<string>,
): TiSourceCatalogEntry[] {
  const enabled = new Set(enabledIds);
  return allTiSourceDescriptors().map((d) => ({
    sourcePolicyId: d.sourcePolicyId,
    label: d.label,
    entityTypes: d.entityTypes,
    enabled: enabled.has(d.sourcePolicyId),
    requiresCustomerKey: d.requiresCustomerKey ?? false,
  }));
}

/**
 * Coerce an arbitrary stored JSONB value into a `string[]` of source ids, or
 * `null` if it is not a well-formed array of non-empty strings. Used for both
 * the per-subject row's `enabled_source_ids` and the global JSONB value.
 */
function coerceIdArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const ids: string[] = [];
  for (const v of value) {
    if (typeof v !== "string" || v.length === 0) return null;
    ids.push(v);
  }
  return ids;
}

/**
 * Intersect a stored id list with the live registry: drop ids no longer
 * registered (logging the drop), de-duplicate, and return sorted. The
 * caller treats an empty result as "this tier is stale" and falls through.
 */
function intersectWithLive(
  stored: string[],
  subjectId: string,
  tier: string,
): string[] {
  const live = liveSourceIdSet();
  const kept: string[] = [];
  const dropped: string[] = [];
  for (const id of stored) {
    if (live.has(id)) kept.push(id);
    else dropped.push(id);
  }
  if (dropped.length > 0) {
    logResolverEvent("stale_unknown_sources", subjectId, { tier, dropped });
  }
  return [...new Set(kept)].sort();
}

/**
 * Resolve the effective enabled source-id set for `subjectId` per the
 * three-tier order (subject selection → admin global → all-enabled).
 * Defensive at every DB tier: a missing/malformed value is logged and
 * skipped, unknown ids are dropped, and a tier whose live intersection is
 * empty falls through. Always returns a NON-EMPTY set — the all-enabled
 * built-in tier is the guaranteed floor.
 *
 * @param db optional Pool/PoolClient (defaults to the auth pool). Pass the
 *   worker's pool to share its connection.
 */
export async function resolveEnabledSources(
  subjectId: string,
  db: Queryable = getAuthPool(),
): Promise<string[]> {
  // Tier 1: per-subject selection.
  try {
    const res = await db.query<{ enabled_source_ids: unknown }>(
      `SELECT enabled_source_ids
         FROM subject_ti_sources
        WHERE subject_id = $1`,
      [subjectId],
    );
    if (res.rows.length > 0) {
      const stored = coerceIdArray(res.rows[0].enabled_source_ids);
      const live = stored
        ? intersectWithLive(stored, subjectId, "subject")
        : [];
      if (live.length > 0) return live;
      logResolverEvent("stale_subject_selection", subjectId, {
        stored: res.rows[0].enabled_source_ids,
        action: "fell back to global/all-enabled",
      });
    }
  } catch (err) {
    logResolverEvent("subject_lookup_failed", subjectId, {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // Tiers 2 + 3: admin global → all-enabled.
  return resolveGlobalEnabledSources(db, subjectId);
}

/**
 * Resolve the enabled set from the global/built-in tiers ONLY — the
 * admin-set `system_settings` default → the all-enabled fallback — skipping
 * the per-subject tier. Always returns a NON-EMPTY set.
 */
export async function resolveGlobalEnabledSources(
  db: Queryable = getAuthPool(),
  logSubject = "global",
): Promise<string[]> {
  try {
    const res = await db.query<{ value: unknown }>(
      `SELECT value FROM system_settings WHERE key = $1`,
      [GLOBAL_TI_SOURCES_DEFAULT_KEY],
    );
    if (res.rows.length > 0) {
      const stored = coerceIdArray(res.rows[0].value);
      const live = stored
        ? intersectWithLive(stored, logSubject, "global")
        : [];
      if (live.length > 0) return live;
      logResolverEvent("stale_global_default", logSubject, {
        stored: res.rows[0].value,
        action: "fell back to all-enabled",
      });
    }
  } catch (err) {
    logResolverEvent("global_lookup_failed", logSubject, {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // Tier 3: all sources enabled (trusted base, never empty).
  return allEnabledSourceIds();
}

// ---------------------------------------------------------------------------
// Write validation
// ---------------------------------------------------------------------------

/**
 * Validate a request body into a non-empty, all-known `enabledSourceIds`
 * list. Throws `HttpError` 400 on a malformed body, 422 on an empty
 * selection (`enabled_source_ids_empty`) or any unknown `sourcePolicyId`
 * (`unknown_source_id`). Returns the de-duplicated, sorted id list.
 *
 * Shared by all three write surfaces (per-subject general, admin
 * per-customer, admin-global) so they apply identical validation.
 */
export function parseEnabledSourceIdsInput(input: unknown): string[] {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new HttpError("Request body must be a JSON object", 400);
  }
  const raw = (input as Record<string, unknown>).enabledSourceIds;
  if (!Array.isArray(raw)) {
    throw new HttpError("enabledSourceIds must be an array", 400);
  }
  for (const v of raw) {
    if (typeof v !== "string" || v.length === 0) {
      throw new HttpError("enabledSourceIds must be non-empty strings", 400);
    }
  }
  const ids = [...new Set(raw as string[])].sort();
  if (ids.length === 0) {
    // Full opt-out is intentionally not a v1 capability (vacuous-`complete`
    // coverage trap). Clearing the row (DELETE → all-enabled default) is the
    // way to "reset", but there is no path to zero sources.
    throw new HttpError("enabled_source_ids_empty", 422);
  }
  const live = liveSourceIdSet();
  const unknown = ids.filter((id) => !live.has(id));
  if (unknown.length > 0) {
    throw new HttpError("unknown_source_id", 422);
  }
  return ids;
}

// ---------------------------------------------------------------------------
// Admin-set global default
// ---------------------------------------------------------------------------

/** Read the admin-set global default, or `null` if unset/malformed. */
export async function readGlobalTiSources(
  client: PoolClient,
): Promise<string[] | null> {
  const res = await client.query<{ value: unknown }>(
    `SELECT value FROM system_settings WHERE key = $1`,
    [GLOBAL_TI_SOURCES_DEFAULT_KEY],
  );
  if (res.rows.length === 0) return null;
  return coerceIdArray(res.rows[0].value);
}

export interface GlobalTiSourcesView {
  /**
   * The raw stored global default (coerced), or `null` when unset. May list
   * sources no longer registered (stale) — check `active`.
   */
  stored: string[] | null;
  /**
   * Whether `stored` has a non-empty live intersection, i.e. whether the
   * resolver would actually use it. `false` for an unset/empty/all-stale value.
   */
  active: boolean;
  /**
   * The effective global-tier selection: the live intersection of `stored`
   * when `active`, else the all-enabled fallback. Mirrors what
   * `resolveGlobalEnabledSources` would pick.
   */
  effective: string[];
  /** Where `effective` came from. */
  source: "global" | "default";
}

/**
 * Read the global default the way the resolver sees it: the raw stored value,
 * whether it is currently registry-active, and the effective fallback. The
 * admin settings page must use THIS so it does not advertise a stale stored
 * value as the live global default while the resolver falls through.
 */
export async function readGlobalTiSourcesView(
  client: PoolClient,
): Promise<GlobalTiSourcesView> {
  const stored = await readGlobalTiSources(client);
  const intersected = stored
    ? intersectWithLive(stored, "global", "global")
    : [];
  if (intersected.length > 0) {
    return {
      stored,
      active: true,
      effective: intersected,
      source: "global",
    };
  }
  return {
    stored,
    active: false,
    effective: allEnabledSourceIds(),
    source: "default",
  };
}

function sameIds(a: readonly string[] | null, b: readonly string[]): boolean {
  if (a === null) return false;
  if (a.length !== b.length) return false;
  return a.every((v, i) => v === b[i]);
}

/**
 * Set the admin-set global default. Admin context only
 * (`system-settings:write`). Validates the selection at save.
 */
export async function setGlobalTiSources(
  client: PoolClient,
  accountId: string,
  input: unknown,
  auditMeta?: { ipAddress: string; sid: string },
): Promise<{ enabledSourceIds: string[]; changed: boolean }> {
  await assertAuthorized(client, "admin", accountId, "system-settings:write");
  const ids = parseEnabledSourceIdsInput(input);
  const prev = await readGlobalTiSources(client);
  const changed = !sameIds(prev, ids);
  if (changed) {
    await client.query(
      `INSERT INTO system_settings (key, value, updated_at)
       VALUES ($1, $2::jsonb, NOW())
       ON CONFLICT (key)
       DO UPDATE SET value = $2::jsonb, updated_at = NOW()`,
      [GLOBAL_TI_SOURCES_DEFAULT_KEY, JSON.stringify(ids)],
    );
    void auditLog({
      actorId: accountId,
      authContext: "admin",
      action: "system.ti_sources_default_updated",
      targetType: "system_settings",
      targetId: GLOBAL_TI_SOURCES_DEFAULT_KEY,
      ipAddress: auditMeta?.ipAddress,
      sid: auditMeta?.sid,
      details: { before: prev, after: ids },
    });
  }
  return { enabledSourceIds: ids, changed };
}

/** Clear the admin-set global default (revert global resolution to all-enabled). */
export async function clearGlobalTiSources(
  client: PoolClient,
  accountId: string,
  auditMeta?: { ipAddress: string; sid: string },
): Promise<{ cleared: boolean }> {
  await assertAuthorized(client, "admin", accountId, "system-settings:write");
  const prev = await readGlobalTiSources(client);
  const res = await client.query(`DELETE FROM system_settings WHERE key = $1`, [
    GLOBAL_TI_SOURCES_DEFAULT_KEY,
  ]);
  const cleared = (res.rowCount ?? 0) > 0;
  if (cleared) {
    void auditLog({
      actorId: accountId,
      authContext: "admin",
      action: "system.ti_sources_default_cleared",
      targetType: "system_settings",
      targetId: GLOBAL_TI_SOURCES_DEFAULT_KEY,
      ipAddress: auditMeta?.ipAddress,
      sid: auditMeta?.sid,
      details: { before: prev },
    });
  }
  return { cleared };
}

// ---------------------------------------------------------------------------
// Per-subject selection (customer-only routes in v1)
// ---------------------------------------------------------------------------

/**
 * The per-subject permission split crosses auth contexts exactly like
 * `customer-default-model`: System Administrator authorizes through the admin
 * context (any customer); Analyst through the general context (assigned
 * customers only, via the analyst-assignment union in `authorizeGeneral`).
 * Both use the SAME `ti-sources:*` key.
 */
async function authorizeSubjectTiSources(
  client: PoolClient,
  authContext: "general" | "admin",
  accountId: string,
  subjectId: string,
  op: "read" | "write",
): Promise<void> {
  const permission = op === "write" ? PERM_WRITE : PERM_READ;
  if (authContext === "admin") {
    await assertAuthorized(client, "admin", accountId, permission);
    return;
  }
  await assertAuthorized(client, "general", accountId, permission, {
    customerId: subjectId,
    operationKind: op,
  });
}

/**
 * v1 management is customer-only: a group subject-id has no `customers` row,
 * so this 404s rather than mis-authorizing it through the customer path. The
 * group surface (general route via the all-member predicates, admin group
 * route) lands with #542.
 */
async function assertCustomerExists(
  client: PoolClient,
  subjectId: string,
): Promise<void> {
  const res = await client.query(`SELECT 1 FROM customers WHERE id = $1`, [
    subjectId,
  ]);
  if (res.rows.length === 0) {
    throw new HttpError("Customer not found", 404);
  }
}

export interface SubjectTiSourcesView {
  /**
   * The subject's own stored selection, or `null` when it has none (or its
   * stored value is stale with an empty live intersection — surfaced as no
   * selection so the UI does not present a set the resolver would skip).
   */
  stored: string[] | null;
  /** The effective resolved enabled set (subject → global → all-enabled). */
  effective: string[];
  /** Where `effective` came from. */
  source: "subject" | "global" | "default";
}

/**
 * Read a subject's own selection (if any) plus the effective resolved set and
 * which tier supplied it. Authorizes read access. Customer-only in v1.
 */
export async function readSubjectTiSources(
  client: PoolClient,
  authContext: "general" | "admin",
  accountId: string,
  subjectId: string,
): Promise<SubjectTiSourcesView> {
  await authorizeSubjectTiSources(
    client,
    authContext,
    accountId,
    subjectId,
    "read",
  );
  await assertCustomerExists(client, subjectId);

  const res = await client.query<{ enabled_source_ids: unknown }>(
    `SELECT enabled_source_ids
       FROM subject_ti_sources
      WHERE subject_id = $1`,
    [subjectId],
  );
  if (res.rows.length > 0) {
    const coerced = coerceIdArray(res.rows[0].enabled_source_ids);
    const intersected = coerced
      ? intersectWithLive(coerced, subjectId, "subject")
      : [];
    if (intersected.length > 0) {
      return { stored: coerced, effective: intersected, source: "subject" };
    }
  }

  const global = await readGlobalTiSourcesView(client);
  return {
    stored: null,
    effective: global.effective,
    source: global.source,
  };
}

/**
 * Set a subject's selection. Authorizes write access (Admin any customer;
 * Analyst assigned customers). Validates the selection at save and records
 * `updated_by`. Returns whether the value actually changed.
 */
export async function setSubjectTiSources(
  client: PoolClient,
  authContext: "general" | "admin",
  accountId: string,
  subjectId: string,
  input: unknown,
  auditMeta?: { ipAddress: string; sid: string },
): Promise<{ enabledSourceIds: string[]; changed: boolean }> {
  await authorizeSubjectTiSources(
    client,
    authContext,
    accountId,
    subjectId,
    "write",
  );
  await assertCustomerExists(client, subjectId);
  const ids = parseEnabledSourceIdsInput(input);

  const before = await client.query<{ enabled_source_ids: unknown }>(
    `SELECT enabled_source_ids
       FROM subject_ti_sources
      WHERE subject_id = $1`,
    [subjectId],
  );
  const prev = before.rows[0]
    ? coerceIdArray(before.rows[0].enabled_source_ids)
    : null;
  const changed = !sameIds(prev, ids);

  if (changed) {
    await client.query(
      `INSERT INTO subject_ti_sources
         (subject_id, enabled_source_ids, updated_at, updated_by)
       VALUES ($1, $2::jsonb, NOW(), $3)
       ON CONFLICT (subject_id)
       DO UPDATE SET enabled_source_ids = $2::jsonb,
                     updated_at = NOW(), updated_by = $3`,
      [subjectId, JSON.stringify(ids), accountId],
    );
    void auditLog({
      actorId: accountId,
      authContext,
      action: "subject_ti_sources.updated",
      targetType: "subject_ti_sources",
      targetId: subjectId,
      customerId: subjectId,
      ipAddress: auditMeta?.ipAddress,
      sid: auditMeta?.sid,
      details: { subjectId, before: prev, after: ids },
    });
  }
  return { enabledSourceIds: ids, changed };
}

/**
 * Clear a subject's selection (delete the row), reverting it to the global /
 * all-enabled default. Authorizes write access. Returns whether a row was
 * actually removed.
 */
export async function clearSubjectTiSources(
  client: PoolClient,
  authContext: "general" | "admin",
  accountId: string,
  subjectId: string,
  auditMeta?: { ipAddress: string; sid: string },
): Promise<{ cleared: boolean }> {
  await authorizeSubjectTiSources(
    client,
    authContext,
    accountId,
    subjectId,
    "write",
  );
  await assertCustomerExists(client, subjectId);
  const before = await client.query<{ enabled_source_ids: unknown }>(
    `SELECT enabled_source_ids
       FROM subject_ti_sources
      WHERE subject_id = $1`,
    [subjectId],
  );
  if (before.rows.length === 0) {
    return { cleared: false };
  }
  await client.query(`DELETE FROM subject_ti_sources WHERE subject_id = $1`, [
    subjectId,
  ]);
  void auditLog({
    actorId: accountId,
    authContext,
    action: "subject_ti_sources.cleared",
    targetType: "subject_ti_sources",
    targetId: subjectId,
    customerId: subjectId,
    ipAddress: auditMeta?.ipAddress,
    sid: auditMeta?.sid,
    details: {
      subjectId,
      before: coerceIdArray(before.rows[0].enabled_source_ids),
    },
  });
  return { cleared: true };
}
