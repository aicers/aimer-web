// RFC 0003 F6 (#594) — runtime helpers for the per-row report-context
// payload (`EnrichmentContextPayload`).
//
// Three concerns live here, all keeping `types.ts` pure-types:
//   - `narrowContextPayload` — the trust boundary. The `context` JSONB on
//     `ioc_feed_snapshot` is `unknown` at runtime (whatever a parser wrote,
//     or a hand-edited row); it is NEVER placed on an `EnrichmentMatch`
//     as-is. This validator narrows it to a typed payload, dropping any
//     field of an unexpected shape and collapsing an empty result to
//     `undefined`.
//   - `normalizeContext` — the single normalization both the hash and the
//     INSERT must agree on. It produces exactly the JSON shape the `context`
//     JSONB column stores (`JSON.stringify` drops `undefined`/non-JSON
//     properties), and collapses an all-empty payload to `undefined`. Without
//     it, `{ actor: "APT1", campaign: undefined }` would persist identically
//     to `{ actor: "APT1" }` yet hash differently, and `{ actor: undefined }`
//     would store a non-null `{}` row while narrowing back to no payload —
//     both undermining hash stability and the "context-less row stays null"
//     guarantee.
//   - `canonicalizeContext` — a stable, sorted-key serialization used by
//     `computeFeedHash`. A bare `JSON.stringify` would hash differently for
//     the same context written with a different key-insertion order,
//     triggering phantom re-imports; sorting keys recursively avoids that.

import type { EnrichmentContextPayload } from "./types";

/**
 * Narrow an `unknown` JSONB `context` value to a typed
 * `EnrichmentContextPayload`. Each known string field is kept only when it
 * is actually a string; `extra` is kept only when it is a plain object.
 * Anything else (a number where a string was expected, an array, a nested
 * unexpected shape) is dropped rather than trusted. Returns `undefined` when
 * nothing usable survives, so a row with `{}`, `null`, or an all-unexpected
 * shape leaves no meaningless empty object on the match.
 */
export function narrowContextPayload(
  value: unknown,
): EnrichmentContextPayload | undefined {
  if (!isPlainObject(value)) return undefined;
  const result: EnrichmentContextPayload = {};
  if (typeof value.actor === "string") result.actor = value.actor;
  if (typeof value.campaign === "string") result.campaign = value.campaign;
  if (typeof value.malwareFamily === "string") {
    result.malwareFamily = value.malwareFamily;
  }
  if (typeof value.reportUrl === "string") result.reportUrl = value.reportUrl;
  if (isPlainObject(value.extra)) result.extra = value.extra;
  return Object.keys(result).length > 0 ? result : undefined;
}

/**
 * Normalize a context payload to the exact JSON shape the `context` JSONB
 * column will store, so the feed hash and the INSERT agree on which
 * properties exist. Mirrors `JSON.stringify` (the insert path): properties
 * whose value is `undefined` — or any other non-JSON value — are dropped,
 * recursively. Returns `undefined` when nothing JSON-serializable survives,
 * so an all-`undefined` payload neither changes `feed_hash` nor leaves a
 * non-null `{}` context row. Callers must use the returned value for *both*
 * hashing and insertion.
 */
export function normalizeContext(
  context: EnrichmentContextPayload,
): EnrichmentContextPayload | undefined {
  const serialized = JSON.stringify(context);
  if (serialized === undefined) return undefined;
  const cleaned = JSON.parse(serialized) as EnrichmentContextPayload;
  return Object.keys(cleaned).length > 0 ? cleaned : undefined;
}

/**
 * Canonical, stable serialization of a context payload for hashing. Object
 * keys are sorted recursively (so the `extra` bag is order-independent too),
 * unlike a bare `JSON.stringify` whose output follows key-insertion order.
 * Expects an already-`normalizeContext`-ed payload, so it never sees an
 * `undefined`-valued property (which it would otherwise serialize as `null`,
 * diverging from the persisted JSON).
 */
export function canonicalizeContext(context: EnrichmentContextPayload): string {
  return stableStringify(context);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** `JSON.stringify` with object keys sorted recursively. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const entries = Object.keys(obj)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(obj[key])}`);
  return `{${entries.join(",")}}`;
}
