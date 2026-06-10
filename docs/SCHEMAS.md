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
  `analyze_params_token` claim, and the PAR row (`lang TEXT`,
  nullable) all accept `null`/missing. When absent, the
  GraphQL variable is omitted and aimer applies its server-side
  default. The cache PK falls back to `DEFAULT_LANG` so explicit
  ENGLISH and "omitted, defaulted" callers land on the same row.

## MITRE ATT&CK data

aimer-web validates LLM-returned MITRE ATT&CK TTP tags
(`ttp_tags`, added in RFC 0002 round 11) before storage. MITRE itself
ships only static STIX bundles — not a classification API — so the
knowledge base lives in this repo as a vendored snapshot.

### Files

```text
schemas/
  mitre-attack-techniques.json   # derived [{id, name}] list, sorted by id
  mitre-attack.version           # pinned upstream revision
scripts/
  mitre-attack-vendor.ts         # bundle → derived JSON converter
```

`schemas/mitre-attack-techniques.json` is consumed at runtime by
`src/lib/analysis/mitre-ttp.ts`'s `validateTtpTags` function. The list
is committed (not generated at build time) so production builds do not
fetch from `github.com/mitre-attack` and reviewers can see the exact
data the validator is using.

The JSON is `{id, name}` rather than `string[]`. `validateTtpTags`
only reads `id`, but keeping `name` lets a human reviewer of a refresh
PR sanity-check that, say, `T1059.001` is still "Command and Scripting
Interpreter: PowerShell" and not a renamed mismatch. The extra bytes
are cheap; the audit-log / UI-tooltip consumer of the name field is
plausible enough to leave the column in place.

### Version pin format

`schemas/mitre-attack.version` accepts either:

- **MITRE-style tag** — e.g. `v19.1` (or unprefixed `19.1`).
  MITRE publishes two-component `vMAJOR.MINOR` tags on
  `mitre-attack/attack-stix-data`. An optional patch component
  (`v19.1.0`) is also accepted for the unlikely future where MITRE
  adopts three-component versioning.
- **Git commit SHA** of `mitre-attack/attack-stix-data` — 7-40 hex
  chars.

Validation regex (note: this **differs** from
`schemas/aimer.version`'s regex — aimer requires three semver
components, MITRE only two):

```text
^v?\d+\.\d+(\.\d+)?$|^[0-9a-f]{7,40}$
```

Both formats are permanent and equally first-class, same policy
intent as `schemas/aimer.version`.

The format is enforced by
`schemas/__tests__/mitre-attack-version.unit.test.ts`.

### Bundle / scope choice

`attack-stix-data` ships three top-level bundles:
`enterprise-attack`, `mobile-attack`, and `ics-attack`. aimer's
threat-detection scope today is **Enterprise**, so the vendor script
pins to `enterprise-attack/enterprise-attack-<semver>.json` only.
Mobile and ICS coverage would land as a separate follow-up issue
rather than an implicit scope expansion.

### Revoked / deprecated filtering

STIX `attack-pattern` objects carry `revoked: true` and
`x_mitre_deprecated: true` flags for IDs MITRE has retired. The
vendor script excludes both — including a retired ID would mean
`validateTtpTags` accepts an LLM tag that MITRE itself no longer
recognizes.

### Bundle file selection from the pin

- **Tag pin**: the Git ref is `v`-prefixed and the bundle filename is
  `v`-stripped, so `v19.1` (or `19.1`) → ref `v19.1`, file
  `enterprise-attack-19.1.json`.
- **SHA pin**: the script lists
  `enterprise-attack/enterprise-attack-*.json` in the tree at that
  SHA and picks the highest semver. Deterministic because the tree at
  a fixed SHA is immutable, so the same SHA always yields the same
  bundle file. No second pin file (e.g.
  `mitre-attack.bundle-version`) is needed.

### Refresh procedure

Run this when you want to consume a newer MITRE release or pull in an
in-flight upstream change.

1. **Pick the desired revision.** Browse
   `https://github.com/mitre-attack/attack-stix-data/releases` for a
   tag, or copy a commit SHA off `main` if you need to track an
   in-flight change. There is no default; both formats are equally
   first-class.

2. **Update the pin.** Single line, no trailing notes:

   ```sh
   echo "<rev>" > schemas/mitre-attack.version
   ```

3. **Regenerate the derived JSON.**

   ```sh
   pnpm tsx scripts/mitre-attack-vendor.ts
   ```

   The script reads `schemas/mitre-attack.version`, fetches the
   matching `enterprise-attack-<semver>.json` from GitHub, drops
   revoked / deprecated `attack-pattern` objects, sorts by ID, and
   writes `schemas/mitre-attack-techniques.json` with stable
   serialization (`JSON.stringify(rows, null, 2) + "\n"`). Two runs
   against the same pin produce byte-identical output, so refresh
   PRs only show the upstream content delta.

4. **Run the tests.**

   ```sh
   pnpm test:unit
   ```

   `schemas/__tests__/mitre-attack-version.unit.test.ts` asserts the
   pin format; `src/lib/analysis/__tests__/mitre-ttp.unit.test.ts`
   exercises the validator against the freshly vendored set.

5. **Spot-check the diff.** Because the JSON carries `name`, a
   reviewer can scan the diff for renamed / removed techniques that
   would surface as `not_in_vendored_mitre` drops at runtime.
