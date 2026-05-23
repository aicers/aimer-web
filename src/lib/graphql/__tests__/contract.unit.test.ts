// GraphQL contract test (RFC 0001 §"GraphQL contract scaffolding").
//
// Parses every operation file under `src/lib/graphql/operations/`
// against the vendored aimer SDL using `graphql-js`'s `buildSchema` +
// `validate`. An SDL refresh that breaks a checked-in operation fails
// here, not at the live `analyzeEvent` runtime call.
//
// Also asserts `schemas/aimer.version` matches the regex documented in
// `docs/SCHEMAS.md` (a semver tag like `0.2.0` or a 7–40-hex commit
// SHA). Both formats are permanent, equally first-class pin formats —
// the choice per refresh is operational, not transitional.
//
// Pairs with `scripts/graphql-codegen.ts check` (the CI step
// `pnpm graphql:check`) which separately ensures the committed
// `__generated__/*.ts` files are in sync with the `.graphql`
// sources.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildSchema,
  type GraphQLEnumType,
  type GraphQLObjectType,
  isNonNullType,
  parse,
  validate,
} from "graphql";
import { describe, expect, it } from "vitest";
import {
  ANALYZE_EVENT_SOURCE,
  AnalyzeEventDocument,
} from "../__generated__/analyze-event";

const SDL_PATH = join(process.cwd(), "schemas/aimer.graphql");
const VERSION_PATH = join(process.cwd(), "schemas/aimer.version");
const OPERATIONS_DIR = join(process.cwd(), "src/lib/graphql/operations");

// Matches `docs/SCHEMAS.md` "Version pin format". Either:
//   - a semver tag (`0.2.0` or `v0.2.0`)
//   - a git commit SHA on aicers/aimer (7–40 hex chars)
const VERSION_RE = /^v?\d+\.\d+\.\d+$|^[0-9a-f]{7,40}$/;

describe("aimer GraphQL contract", () => {
  const schema = buildSchema(readFileSync(SDL_PATH, "utf-8"));

  it("vendored SDL parses cleanly with buildSchema", () => {
    expect(() => buildSchema(readFileSync(SDL_PATH, "utf-8"))).not.toThrow();
  });

  it("every operation file validates against the vendored SDL", () => {
    const entries = readdirSync(OPERATIONS_DIR, { withFileTypes: true });
    const operationFiles = entries
      .filter((e) => e.isFile() && e.name.endsWith(".graphql"))
      .map((e) => e.name);
    expect(operationFiles.length).toBeGreaterThan(0);

    for (const name of operationFiles) {
      const source = readFileSync(join(OPERATIONS_DIR, name), "utf-8");
      const document = parse(source);
      const errors = validate(schema, document);
      expect(
        errors,
        `operation ${name} does not validate:\n${errors
          .map((e) => `  - ${e.message}`)
          .join("\n")}`,
      ).toEqual([]);
    }
  });

  it("AnalyzeEvent operation parses against the SDL", () => {
    const document = parse(ANALYZE_EVENT_SOURCE);
    const errors = validate(schema, document);
    expect(errors).toEqual([]);
  });

  it("AnalyzeEventDocument is a parsed DocumentNode (not a raw string)", () => {
    // graphqlRequest's runtime guard rejects strings; the generated
    // export must therefore be a DocumentNode-shaped object.
    expect(typeof AnalyzeEventDocument).toBe("object");
    expect(AnalyzeEventDocument).toMatchObject({ kind: "Document" });
  });

  it("AnalysisResult preserves field names, scalar types, and non-null markers", () => {
    // The committed `__generated__/analyze-event.ts` types are derived
    // from the SDL, so a regression here (e.g. `threatScore: Float!`
    // → `threatScore: String`, or making `analysis` nullable) flows
    // straight into the TypedDocumentNode's response type. This
    // assertion fails alongside `pnpm graphql:check` so the contract
    // breakage shows up explicitly rather than as a downstream TS
    // error.
    const result = schema.getType("AnalysisResult") as
      | GraphQLObjectType
      | undefined;
    expect(result).toBeDefined();
    if (!result) return;
    const fields = result.getFields();
    expect(Object.keys(fields).sort()).toEqual(["analysis", "threatScore"]);

    // threatScore: Float!  (non-null Float)
    expect(isNonNullType(fields.threatScore.type)).toBe(true);
    expect(String(fields.threatScore.type)).toBe("Float!");

    // analysis: String!  (non-null String)
    expect(isNonNullType(fields.analysis.type)).toBe(true);
    expect(String(fields.analysis.type)).toBe("String!");
  });

  it("Language enum exposes only KOREAN and ENGLISH", () => {
    const lang = schema.getType("Language") as GraphQLEnumType | undefined;
    expect(lang).toBeDefined();
    if (!lang) return;
    expect(
      lang
        .getValues()
        .map((v) => v.name)
        .sort(),
    ).toEqual(["ENGLISH", "KOREAN"]);
  });

  it("analyzeEvent mutation pins variable types and return non-null markers", () => {
    // Mutation root's analyzeEvent signature is part of the contract.
    // The codegen reads variable types from this signature to emit
    // `AnalyzeEventVariables`, and reads the return type to emit
    // `AnalyzeEventResponse`. A non-null relaxation (e.g.
    // `AnalysisResult!` → `AnalysisResult`) would silently widen the
    // TypedDocumentNode's response type unless surfaced here.
    const mutation = schema.getMutationType();
    expect(mutation).toBeDefined();
    if (!mutation) return;
    const analyze = mutation.getFields().analyzeEvent;
    expect(analyze).toBeDefined();

    expect(isNonNullType(analyze.type)).toBe(true);
    expect(String(analyze.type)).toBe("AnalysisResult!");

    const argMap = Object.fromEntries(
      analyze.args.map((a) => [a.name, String(a.type)]),
    );
    // `lang` is NULLABLE (`Language`, not `Language!`) — aimer applies
    // its own default when the variable is absent. Calls sites must
    // therefore be free to pass `null`/`undefined` for `lang`.
    expect(argMap).toEqual({
      event: "String!",
      eventTime: "DateTime!",
      name: "String!",
      model: "String!",
      lang: "Language",
    });
  });

  it("SDL exposes a DateTime scalar", () => {
    // `Mutation.analyzeEvent`'s `eventTime` argument relies on the
    // `DateTime` custom scalar; the codegen's `SCALAR_TS_MAP` only
    // maps it correctly if it actually appears as a scalar in the SDL.
    const dateTime = schema.getType("DateTime");
    expect(dateTime).toBeDefined();
    expect(String(dateTime)).toBe("DateTime");
  });
});

describe("schemas/aimer.version", () => {
  it("matches the accepted semver-tag or commit-SHA shape", () => {
    const raw = readFileSync(VERSION_PATH, "utf-8");
    const trimmed = raw.trim();
    expect(
      VERSION_RE.test(trimmed),
      `schemas/aimer.version value ${JSON.stringify(trimmed)} does not match ${VERSION_RE}`,
    ).toBe(true);
  });

  it("contains a single non-empty line", () => {
    // Authoring guardrail — multi-line content (notes, tag annotations,
    // accidental SDL paste) would break tooling that reads the pin as a
    // ref. The file may include a trailing newline but no second value.
    const raw = readFileSync(VERSION_PATH, "utf-8");
    const lines = raw.split("\n").filter((l) => l.trim().length > 0);
    expect(lines).toHaveLength(1);
  });

  it("regex sanity — accepts both 0.2.0 and 29e722f", () => {
    // The pin regex must remain symmetric across the two equally
    // first-class formats. A refactor that, say, requires `v` prefix
    // or drops the SHA branch would silently regress this property
    // unless asserted directly.
    expect(VERSION_RE.test("0.2.0")).toBe(true);
    expect(VERSION_RE.test("v0.2.0")).toBe(true);
    expect(VERSION_RE.test("29e722f")).toBe(true);
    expect(VERSION_RE.test("29e722f890c5a31bca5242c4c69cdc1749c11e8b")).toBe(
      true,
    );

    expect(VERSION_RE.test("")).toBe(false);
    expect(VERSION_RE.test("main")).toBe(false);
    expect(VERSION_RE.test("0.2")).toBe(false);
    // Six hex chars is below the minimum SHA length.
    expect(VERSION_RE.test("29e722")).toBe(false);
    // Forty-one hex chars exceeds full-SHA length.
    expect(VERSION_RE.test("29e722f890c5a31bca5242c4c69cdc1749c11e8bf")).toBe(
      false,
    );
  });
});
