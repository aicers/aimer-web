// RFC 0003 F6 (#594) — runtime helpers for the per-row report-context
// payload (`EnrichmentContextPayload`).
//
// Two concerns live here, both keeping `types.ts` pure-types:
//   - `narrowContextPayload` — the trust boundary. The `context` JSONB on
//     `ioc_feed_snapshot` is `unknown` at runtime (whatever a parser wrote,
//     or a hand-edited row); it is NEVER placed on an `EnrichmentMatch`
//     as-is. This validator narrows it to a typed payload, dropping any
//     field of an unexpected shape and collapsing an empty result to
//     `undefined`.
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
 * Canonical, stable serialization of a context payload for hashing. Object
 * keys are sorted recursively (so the `extra` bag is order-independent too),
 * unlike a bare `JSON.stringify` whose output follows key-insertion order.
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
