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
}

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
  }>(
    pool,
    `SELECT aice_id, issuer, kid, public_key FROM trust_registry WHERE enabled = true`,
  );

  const map = new Map<string, TrustRegistryEntry>();
  for (const row of rows) {
    map.set(cacheKey(row.aice_id, row.issuer, row.kid), {
      aiceId: row.aice_id,
      issuer: row.issuer,
      kid: row.kid,
      publicKey: row.public_key,
    });
  }
  return map;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Look up a public key from the trust registry by (aice_id, issuer, kid).
 * Returns null if the key is not found or is disabled.
 */
export async function lookupTrustRegistryKey(
  pool: Pool,
  aiceId: string,
  issuer: string,
  kid: string,
): Promise<TrustRegistryEntry | null> {
  const now = Date.now();
  if (!cache || now >= cacheExpiresAt) {
    cache = await loadAll(pool);
    cacheExpiresAt = now + CACHE_TTL_MS;
  }
  return cache.get(cacheKey(aiceId, issuer, kid)) ?? null;
}

/** Invalidate the cache (useful after admin key management operations). */
export function invalidateTrustRegistryCache(): void {
  cache = null;
  cacheExpiresAt = 0;
}
