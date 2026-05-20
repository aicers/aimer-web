// GraphQL contract test (RFC 0001 §"GraphQL contract scaffolding").
//
// Parses every operation file under `src/lib/graphql/operations/`
// against the vendored aimer SDL using `graphql-js`'s `buildSchema` +
// `validate`. An SDL refresh that breaks a checked-in operation fails
// here, not at the live `analyzeEvent` runtime call.
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

const SDL_PATH = join(process.cwd(), "src/lib/graphql/aimer.schema.graphql");
const OPERATIONS_DIR = join(process.cwd(), "src/lib/graphql/operations");

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
    expect(argMap).toEqual({
      eventData: "JSON!",
      name: "String!",
      model: "String!",
      lang: "Language!",
    });
  });
});
