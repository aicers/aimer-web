// RFC 0005 — CVE id canonicalization.
//
// `normalizeCve` is the CVE analogue of the `TTP_ID_RE` guard in
// `mitre-ttp.ts`: it canonicalizes an LLM-emitted CVE id to a stable
// upper-case form for dedup and catalog lookup. It is NOT the precision
// gate — the aimer backend already enforces the canonical CVE form
// (`^CVE-[0-9]{4}-[0-9]{4,}$`) on emitted `cveRefs` and errors the whole
// analysis on a malformed id (mirroring `validate_ttp_tags`), so every
// ref aimer-web receives is already well-formed. The precision value-add
// is existence validation against the catalog (`validateCveRefs`), where
// a well-formed-but-non-existent id like `CVE-2099-99999` is dropped.
//
// This module is pure (no `server-only`, no I/O) so it can be reused from
// any layer and unit-tested without a `server-only` mock.

// Canonical CVE id: `CVE-YYYY-N{4,}` — a four-digit year and a sequence
// number of at least four digits (CVE ids grew past 9999/year in 2014, so
// the sequence is variable-length). Case-insensitive on input; the
// canonical form is upper-case. Surrounding whitespace is tolerated and
// trimmed (belt-and-suspenders for a stray space the LLM may emit).
const CVE_ID_RE = /^CVE-([0-9]{4})-([0-9]{4,})$/i;

/**
 * Canonicalize a raw CVE id to upper-case `CVE-YYYY-N{4,}`, or return
 * `null` when it is not a well-formed CVE id.
 *
 * The leading zeros of the sequence number are preserved (the canonical
 * CVE id `CVE-2024-0001` is distinct as a string from `CVE-2024-1`, and
 * the latter is not a valid CVE id anyway since the sequence is `{4,}`
 * digits). Normalization only upper-cases the `CVE` prefix and trims
 * surrounding whitespace; it never rewrites the numeric parts.
 */
export function normalizeCve(raw: string): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  const m = CVE_ID_RE.exec(trimmed);
  if (m === null) return null;
  return `CVE-${m[1]}-${m[2]}`;
}
