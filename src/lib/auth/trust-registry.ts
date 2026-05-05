import "server-only";

import type { Pool } from "pg";
import { query } from "../db/client";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TrustRegistryEntry {
  aiceId: string;
  issuer: string;
  kid: string;
  publicKey: JsonWebKey;
  /**
   * Optional hard-expiry timestamp (UTC ms epoch). When set, the key is
   * rejected if `Date.now() > expiresAtMs`. NULL → soft-expiry (governed by
   * `enabled` only).
   */
  expiresAtMs: number | null;
}

/** Reason returned by {@link lookupTrustRegistryKey} when a key is rejected. */
export type TrustRegistryLookupRejection =
  | { reason: "unknown" }
  | { reason: "expired"; expiresAtMs: number };

export type TrustRegistryLookupResult =
  | { entry: TrustRegistryEntry; rejection: null }
  | { entry: null; rejection: TrustRegistryLookupRejection };

// ---------------------------------------------------------------------------
// Cache — 60-second TTL, full table load
// ---------------------------------------------------------------------------

let cache: Map<string, TrustRegistryEntry> | null = null;
let cacheExpiresAt = 0;

const CACHE_TTL_MS = 60_000;

function cacheKey(aiceId: string, issuer: string, kid: string): string {
  return `${aiceId}\0${issuer}\0${kid}`;
}

async function loadAll(pool: Pool): Promise<Map<string, TrustRegistryEntry>> {
  const rows = await query<{
    aice_id: string;
    issuer: string;
    kid: string;
    public_key: JsonWebKey;
    expires_at: string | Date | null;
  }>(
    pool,
    `SELECT aice_id, issuer, kid, public_key, expires_at
       FROM trust_registry
      WHERE enabled = true`,
  );

  const map = new Map<string, TrustRegistryEntry>();
  for (const row of rows) {
    let expiresAtMs: number | null = null;
    if (row.expires_at != null) {
      const date =
        row.expires_at instanceof Date
          ? row.expires_at
          : new Date(row.expires_at);
      const ms = date.getTime();
      expiresAtMs = Number.isFinite(ms) ? ms : null;
    }
    map.set(cacheKey(row.aice_id, row.issuer, row.kid), {
      aiceId: row.aice_id,
      issuer: row.issuer,
      kid: row.kid,
      publicKey: row.public_key,
      expiresAtMs,
    });
  }
  return map;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Look up a public key from the trust registry by (aice_id, issuer, kid).
 *
 * Returns a result discriminating between a hit, an unknown key, and an
 * explicitly expired key. Expiry (`expires_at`) is evaluated on every call
 * against the live clock, NOT just when the cache is loaded — so a key that
 * crosses its expiry boundary mid-cache-window is rejected immediately on the
 * next verify rather than potentially passing for up to {@link CACHE_TTL_MS}.
 */
export async function lookupTrustRegistryKey(
  pool: Pool,
  aiceId: string,
  issuer: string,
  kid: string,
): Promise<TrustRegistryLookupResult> {
  const now = Date.now();
  if (!cache || now >= cacheExpiresAt) {
    cache = await loadAll(pool);
    cacheExpiresAt = now + CACHE_TTL_MS;
  }
  const entry = cache.get(cacheKey(aiceId, issuer, kid));
  if (!entry) {
    return { entry: null, rejection: { reason: "unknown" } };
  }
  if (entry.expiresAtMs != null && now > entry.expiresAtMs) {
    return {
      entry: null,
      rejection: { reason: "expired", expiresAtMs: entry.expiresAtMs },
    };
  }
  return { entry, rejection: null };
}

/** Invalidate the cache (useful after admin key management operations). */
export function invalidateTrustRegistryCache(): void {
  cache = null;
  cacheExpiresAt = 0;
}
