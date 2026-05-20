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
import { buildSchema, parse, validate } from "graphql";
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

  it("AnalysisResult { threatScore, analysis } shape is preserved on the schema side", () => {
    const result = schema.getType("AnalysisResult");
    expect(result).toBeDefined();
    // narrow: GraphQLObjectType has getFields()
    const fields = (
      result as { getFields(): Record<string, unknown> }
    ).getFields();
    expect(Object.keys(fields).sort()).toEqual(["analysis", "threatScore"]);
  });

  it("Language enum exposes only KOREAN and ENGLISH", () => {
    const lang = schema.getType("Language");
    expect(lang).toBeDefined();
    const values = (
      lang as unknown as {
        getValues(): { name: string }[];
      }
    ).getValues();
    expect(values.map((v) => v.name).sort()).toEqual(["ENGLISH", "KOREAN"]);
  });
});
