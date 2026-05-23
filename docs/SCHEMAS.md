# Backend GraphQL schema vendoring

aimer-web is a BFF in front of [aimer](https://github.com/aicers/aimer)
(`auth-mtls` build). The wire contract between the two — GraphQL
operations against aimer's `analyzeEvent` mutation — is pinned by
vendoring aimer's checked-in SDL into this repo and recording the exact
upstream revision the SDL was copied from.

This document covers:

- where the vendored artifacts live and what each file means;
- the version-pin format and policy;
- the refresh procedure when aimer ships a schema-affecting change.

The matching upstream document is aimer's README under "GraphQL schema
artifact" and "Versioning and pin contract".

## Files

```text
schemas/
  aimer.graphql   # byte-for-byte copy of aicers/aimer:schema.graphql
                  # at the revision named in aimer.version
  aimer.version   # exact aimer revision the SDL was copied from
```

`schemas/aimer.graphql` is the SDL `pnpm graphql:codegen` reads to emit
`src/lib/graphql/__generated__/*.ts`. It is also the input the
GraphQL contract test (`src/lib/graphql/__tests__/contract.unit.test.ts`)
parses every committed operation against, so a refresh that breaks an
operation fails CI rather than the runtime call.

`schemas/aimer.version` is the single-line pin recording which aimer
revision the SDL came from. Tooling and reviewers read this file (and
not the commit history of `aimer.graphql`) when asking "which aimer
build does aimer-web target?".

aimer-web never runs aimer's regeneration command itself. The
authoritative producer of `schema.graphql` is aimer's CI; aimer-web's
contract is "copy what's checked in upstream".

## Version pin format

`schemas/aimer.version` accepts either:

- **Semver tag** — e.g. `0.2.0` or `v0.2.0`. Use this when you want
  release semantics: stable known-good points, release branches,
  production deploys.
- **Git commit SHA** of `aicers/aimer` — 7–40 hex chars, e.g.
  `29e722f` or
  `29e722f890c5a31bca5242c4c69cdc1749c11e8b`. Use this when you need
  to track an in-flight aimer change before it lands in a release, or
  when the consumer wants to pin a specific commit regardless of
  release state.

Validation regex:

```text
^v?\d+\.\d+\.\d+$|^[0-9a-f]{7,40}$
```

Both formats are **permanent and equally first-class**. A SHA pin is
never a stopgap waiting on a tag; tags and SHAs each fit different
operational moments and either is acceptable at any time. This is a
deliberate divergence from aice-web-next's strict-semver policy —
aimer does not yet have a mature release cadence, and even after it
does, fast-iteration scenarios across the BFF / backend boundary
remain valuable.

The contract test (`schemas/aimer.version` block in
`src/lib/graphql/__tests__/contract.unit.test.ts`) enforces the format.

## Refresh procedure

Run this when aimer ships a schema-affecting change you need to consume
on the aimer-web side (a new resolver, a renamed argument, a scalar
swap, etc.).

1. **Pick the desired aimer revision.** Decide whether the refresh is
   a release-semantics moment (semver tag) or an in-flight integration
   (commit SHA). Either format is acceptable — there is no default.

2. **Copy `schema.graphql` from aimer's repo root at that revision.**
   The link form used in PR descriptions and refresh commits must be
   `https://github.com/aicers/aimer/blob/<exact-sha-or-tag>/schema.graphql`,
   never `…/blob/main/…`, so the reference does not drift if `main`
   advances after the PR is opened. Aimer's README "Regenerating
   `schema.graphql`" section is the authoritative reference for how
   that file is produced; aimer-web does **not** run the regeneration
   command itself.

   ```sh
   # `<rev>` is the chosen tag or SHA.
   curl -fsSL \
     "https://raw.githubusercontent.com/aicers/aimer/<rev>/schema.graphql" \
     > schemas/aimer.graphql
   ```

   Do **not** hand-edit the vendored file. Reviewers expect it to be a
   byte-for-byte copy.

3. **Write the chosen tag/SHA into `schemas/aimer.version`.** Single
   line, no trailing notes:

   ```sh
   echo "<rev>" > schemas/aimer.version
   ```

4. **Re-run codegen.** This refreshes
   `src/lib/graphql/__generated__/*.ts` from the new SDL plus the
   committed operations under `src/lib/graphql/operations/`.

   ```sh
   pnpm graphql:codegen
   ```

5. **Ensure contract + format tests pass.**

   ```sh
   pnpm graphql:check               # generated files match the SDL+ops
   pnpm test:unit                   # includes contract + version-format
   ```

   If `graphql:check` fails, the regeneration is out of sync — re-run
   `graphql:codegen` and commit the result alongside the SDL bump.

6. **Run the analyze flow against a real aimer `auth-mtls` instance**
   before merging the refresh PR. Type-checking and unit tests verify
   shape conformance; only an end-to-end call confirms that the BFF's
   serialization choices (notably `event` JSON encoding and
   `eventTime` formatting) still match aimer's resolver expectations.

## Custom scalar mapping

The codegen's scalar map lives in `scripts/graphql-codegen.ts`
(`SCALAR_TS_MAP`). When the upstream SDL grows a new custom scalar,
add a mapping there before re-running codegen — an unknown scalar
falls through to `unknown` so call sites stop compiling until the
mapping is decided explicitly.

Current mappings (load-bearing notes only — see `SCALAR_TS_MAP` for
the full list):

- `DateTime` → `string`. aimer's `DateTime` carries RFC 3339 /
  ISO 8601 date-time values which `jiff::Timestamp` parses upstream.
  The BFF forwards the string verbatim (no re-serialization) so the
  source's offset / fractional-second representation is preserved.
  Fractional seconds are capped at 9 digits to match
  `jiff::Timestamp`'s nanosecond precision; finer-grained inputs are
  rejected at ingest so a bad value cannot get stored in
  `redacted_event.event_time` and win over corrected request values
  on later retries.
- `StringNumber` → `string`. aimer uses `StringNumber` to carry `i128`
  values (e.g. `EventSelector.timestamp`'s nanoseconds since epoch).
  It MUST map to a decimal string; `number` would lose precision past
  `2^53`, and call sites must never coerce via `Number(...)`.
- `TimestampIso8601` → `string`. ISO-8601 date-time strings round-trip
  through the BFF as strings without parsing.

## `analyzeEvent` variable sourcing notes

When the vendored SDL is refreshed, double-check that these sourcing
rules still hold for `Mutation.analyzeEvent`:

- `event: String!` — `JSON.stringify(redactedEvent)` with default key
  order. aimer's downstream redact / LLM stages accept any valid JSON.
- `eventTime: DateTime!` — sourced from `event_data.event_time`, an
  RFC 3339 / ISO 8601 date-time string. The value flows untouched
  from request → (optional cache-poisoning extraction from the stored
  `redacted_event`) → upstream, where aimer parses it with
  `jiff::Timestamp`. NOT sourced from the BFF's `event_key`: that
  column is a `NUMERIC(39, 0)` row identifier and carries no
  timestamp semantics (see `src/lib/event-key.ts`). When the route
  short-circuits on an existing `detection_events` row, the value is
  re-extracted from the STORED `redacted_event` so attacker-supplied
  payloads cannot shift the rendered analysis time.
- `lang: Language` — nullable. The BFF preserves caller-supplied
  absence end-to-end: the request body, the bridge's
  `analyze_params_token` claim, and the PAR row (`lang TEXT`, nullable
  after migration `0026`) all accept `null`/missing. When absent, the
  GraphQL variable is omitted and aimer applies its server-side
  default. The cache PK falls back to `DEFAULT_LANG` so explicit
  ENGLISH and "omitted, defaulted" callers land on the same row.
