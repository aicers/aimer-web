import "server-only";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface CacheEntry {
  plaintext: Buffer;
  timer: NodeJS.Timeout;
}

// ---------------------------------------------------------------------------
// DEK Cache
// ---------------------------------------------------------------------------

const DEFAULT_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * In-memory cache for plaintext DEKs with automatic TTL eviction.
 *
 * - Clones Buffers on both `set()` and `get()` so caller zeroing
 *   never corrupts the cache, and cache eviction never corrupts
 *   a Buffer the caller is still using.
 * - Zeroes internal Buffers on eviction and `clear()`.
 * - Never persisted — lost on process restart by design.
 */
export class DekCache {
  private readonly map = new Map<string, CacheEntry>();
  private readonly ttlMs: number;

  constructor(ttlMs = DEFAULT_TTL_MS) {
    this.ttlMs = ttlMs;
  }

  private static cacheKey(keyName: string, wrappedDek: string): string {
    return `${keyName}:${wrappedDek}`;
  }

  get size(): number {
    return this.map.size;
  }

  get(keyName: string, wrappedDek: string): Buffer | undefined {
    const entry = this.map.get(DekCache.cacheKey(keyName, wrappedDek));
    if (!entry) return undefined;
    // Return a clone so the caller can safely zero it
    return Buffer.from(entry.plaintext);
  }

  set(keyName: string, wrappedDek: string, plaintext: Buffer): void {
    const key = DekCache.cacheKey(keyName, wrappedDek);

    // Evict existing entry if present
    const existing = this.map.get(key);
    if (existing) {
      clearTimeout(existing.timer);
      existing.plaintext.fill(0);
    }

    // Store a clone so the caller can safely zero the original
    const clone = Buffer.from(plaintext);
    const timer = setTimeout(() => {
      clone.fill(0);
      this.map.delete(key);
    }, this.ttlMs);

    // Allow the timer to not prevent process exit
    if (typeof timer.unref === "function") {
      timer.unref();
    }

    this.map.set(key, { plaintext: clone, timer });
  }

  invalidate(keyName: string, wrappedDek: string): void {
    const key = DekCache.cacheKey(keyName, wrappedDek);
    const entry = this.map.get(key);
    if (entry) {
      clearTimeout(entry.timer);
      entry.plaintext.fill(0);
      this.map.delete(key);
    }
  }

  clear(): void {
    for (const entry of this.map.values()) {
      clearTimeout(entry.timer);
      entry.plaintext.fill(0);
    }
    this.map.clear();
  }
}

/** Module-level singleton. */
export const dekCache = new DekCache();
