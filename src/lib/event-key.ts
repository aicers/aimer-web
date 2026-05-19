import { z } from "zod";

/**
 * `event_key` is a NUMERIC(39, 0) on the DB side. On the wire it travels
 * as a JSON string (RFC 0002 §6 — NUMERIC(39, 0) overflows JSON numbers).
 * Length is capped at 39 digits to match the DB precision; values with
 * more digits would fail the `$::numeric` cast after the route has
 * already consumed the context-token `jti`.
 *
 * The canonical form rejects leading zeros (`"01"` etc.) — the DB
 * natural key is numeric, so `"1"` and `"01"` collapse to the same
 * row, and accepting both forms would let payload-internal duplicate
 * guards in `withdraw` / `refresh-window` / `backfill` miss collisions
 * that the DB will then resolve as either a PK violation (500 after
 * the jti is consumed) or, for withdraw, a `withdrawn`/`not_found`
 * count corruption. Literal `"0"` is allowed because zero is a valid
 * NUMERIC value.
 *
 * Canonical form is also load-bearing for the redaction map's
 * advisory-lock key: two callers using `"1"` and `"01"` for the same
 * numeric value would hash to different locks and race past each other
 * even though the DB primary key collapses both to the same row in
 * `event_redaction_map`. See `src/lib/redaction/map-write.ts`.
 */
export const eventKeyString = z
  .string()
  .min(1)
  .max(39)
  .regex(
    /^(0|[1-9][0-9]{0,38})$/,
    "event_key must be a canonical non-negative integer string (no leading zeros)",
  );
