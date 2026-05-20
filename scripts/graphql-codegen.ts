// GraphQL codegen — emit a TypedDocumentNode TypeScript file per
// `.graphql` operation under `src/lib/graphql/operations/`.
//
// This is a deliberately minimal alternative to `@graphql-codegen/cli`:
// the project's footprint here is small and pulling the full toolchain
// would dwarf the generated output. We keep the surface area small
// while preserving the safety net the issue calls for: TypeScript
// variable and result types are DERIVED from the vendored SDL using
// `graphql-js`'s type system, not hand-written per operation. A scalar
// or nullability change on the SDL side therefore surfaces as a
// regenerated diff (and, if uncommitted, as a `pnpm graphql:check`
// failure in CI).
//
// Pipeline per operation file:
//   1. Parse the operation against the vendored SDL with `graphql-js`
//      (catches schema drift at codegen time).
//   2. Walk the operation's `VariableDefinition`s against the schema
//      to emit `<Operation>Variables`.
//   3. Walk each field selection against its schema type to emit
//      `<Operation>Response` (and nested response interfaces, if any).
//   4. Emit a self-contained TS module that re-parses the operation
//      string at module load and exports it as
//      `TypedDocumentNode<<Response>, <Variables>>`.
//
// The emitted files are committed to `src/lib/graphql/__generated__/`
// (no .gitignore) so `pnpm tsc --noEmit` / `pnpm biome check` work
// without a pre-step and "go to definition" lands inside this repo.
//
// `pnpm graphql:codegen` rewrites the committed files. `pnpm
// graphql:check` runs the same codegen against a temp directory and
// fails if the committed files would change — CI surfaces drift
// between the `.graphql` source and the committed output.

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildSchema,
  type DocumentNode,
  type FieldNode,
  type GraphQLEnumType,
  type GraphQLNamedType,
  type GraphQLObjectType,
  GraphQLObjectType as GraphQLObjectTypeClass,
  type GraphQLOutputType,
  type GraphQLSchema,
  type GraphQLType,
  isEnumType,
  isListType,
  isNonNullType,
  isObjectType,
  isScalarType,
  type OperationDefinitionNode,
  parse,
  type TypeNode,
  typeFromAST,
  type VariableDefinitionNode,
  validate,
} from "graphql";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const REPO_ROOT = resolve(__dirname, "..");
const SDL_PATH = join(REPO_ROOT, "src/lib/graphql/aimer.schema.graphql");
const OPERATIONS_DIR = join(REPO_ROOT, "src/lib/graphql/operations");
const DEFAULT_OUT_DIR = join(REPO_ROOT, "src/lib/graphql/__generated__");

// Map of custom scalars → TS types. Built-in scalars (Int/Float/String/
// Boolean/ID) are handled in `renderType`. Add an entry here when the
// vendored SDL grows a new custom scalar.
const SCALAR_TS_MAP: Record<string, string> = {
  JSON: "Record<string, unknown>",
  // Built-in fallback covered in renderType; listed here for
  // self-documentation.
  Int: "number",
  Float: "number",
  String: "string",
  Boolean: "boolean",
  ID: "string",
};

interface CodegenResult {
  /** Map of absolute output path → file content. */
  files: Map<string, string>;
}

// ---------------------------------------------------------------------------
// Type rendering
// ---------------------------------------------------------------------------

function renderScalar(name: string): string {
  const mapped = SCALAR_TS_MAP[name];
  if (mapped) return mapped;
  // Unknown custom scalar — emit `unknown` so the type system flags
  // any use until the scalar is added to `SCALAR_TS_MAP`.
  return "unknown";
}

function renderEnum(enumType: GraphQLEnumType): string {
  const values = enumType.getValues();
  if (values.length === 0) return "never";
  return values.map((v) => JSON.stringify(v.name)).join(" | ");
}

interface RenderedType {
  /** TS expression including null wrappers if the GraphQL type is nullable. */
  tsType: string;
  /** Nested object types this rendering depended on. Used to emit interfaces. */
  nestedObjects: GraphQLObjectType[];
}

/**
 * Render a GraphQL type (variable type or field return type) to a TS
 * type expression. Object types are rendered by NAME — the caller is
 * responsible for emitting interface declarations for them.
 *
 * Nullability semantics follow the GraphQL spec: a type is nullable
 * UNLESS wrapped in `NonNullType`. `[T]` is therefore `Array<T> | null`
 * even when `T` itself is non-null; `[T]!` is `Array<T>`; `[T!]!` is
 * `Array<T>` with non-null items.
 */
function renderType(type: GraphQLType): RenderedType {
  if (isNonNullType(type)) {
    return renderInner(type.ofType, /* nullable */ false);
  }
  return renderInner(type, /* nullable */ true);
}

function renderInner(type: GraphQLType, nullable: boolean): RenderedType {
  const suffix = nullable ? " | null" : "";
  if (isListType(type)) {
    // List items go through `renderType` so the item's own NonNull
    // wrapper (if any) is respected independently of the list itself.
    const item = renderType(type.ofType);
    return {
      tsType: `Array<${item.tsType}>${suffix}`,
      nestedObjects: item.nestedObjects,
    };
  }
  if (isScalarType(type)) {
    return { tsType: `${renderScalar(type.name)}${suffix}`, nestedObjects: [] };
  }
  if (isEnumType(type)) {
    return { tsType: `${renderEnum(type)}${suffix}`, nestedObjects: [] };
  }
  if (isObjectType(type)) {
    return { tsType: `${type.name}${suffix}`, nestedObjects: [type] };
  }
  // Interfaces / unions / input objects aren't reached by current
  // operations; explicit failure is preferable to silent `unknown`.
  throw new Error(
    `codegen: unsupported GraphQL type kind for "${(type as GraphQLNamedType).name ?? "(anonymous)"}"`,
  );
}

/**
 * Variant of `renderType` that takes a `TypeNode` from the AST
 * (variable definitions arrive as AST nodes, not resolved schema
 * types). We resolve via `typeFromAST` to honour custom scalar and
 * enum lookups against the vendored SDL.
 */
function renderTypeNode(schema: GraphQLSchema, node: TypeNode): RenderedType {
  const resolved = typeFromAST(
    schema,
    node as Parameters<typeof typeFromAST>[1],
  );
  if (!resolved) {
    throw new Error(
      `codegen: variable type references unknown SDL type "${describeTypeNode(node)}"`,
    );
  }
  return renderType(resolved);
}

function describeTypeNode(node: TypeNode): string {
  if (node.kind === "NonNullType") return `${describeTypeNode(node.type)}!`;
  if (node.kind === "ListType") return `[${describeTypeNode(node.type)}]`;
  return node.name.value;
}

// ---------------------------------------------------------------------------
// Variable + response interface generation
// ---------------------------------------------------------------------------

interface InterfaceDef {
  name: string;
  fields: { name: string; tsType: string }[];
}

function renderVariablesInterface(
  schema: GraphQLSchema,
  opName: string,
  variableDefs: readonly VariableDefinitionNode[],
): { def: InterfaceDef; nestedObjects: GraphQLObjectType[] } {
  const fields: InterfaceDef["fields"] = [];
  const nested: GraphQLObjectType[] = [];
  for (const v of variableDefs) {
    const rendered = renderTypeNode(schema, v.type);
    fields.push({ name: v.variable.name.value, tsType: rendered.tsType });
    nested.push(...rendered.nestedObjects);
  }
  return {
    def: { name: `${opName}Variables`, fields },
    nestedObjects: nested,
  };
}

/**
 * Walk a selection set against an object type and emit a TS interface
 * whose fields are typed from the schema (NOT from the operation source
 * alone). Nested object selections are queued separately by the
 * top-level driver so a single named interface is emitted per
 * referenced object type.
 */
function renderSelectionInterface(
  _schema: GraphQLSchema,
  interfaceName: string,
  parentType: GraphQLObjectType,
  selections: readonly FieldNode[],
): { def: InterfaceDef; nestedObjects: GraphQLObjectType[] } {
  const fields: InterfaceDef["fields"] = [];
  const nested: GraphQLObjectType[] = [];
  const parentFields = parentType.getFields();

  for (const sel of selections) {
    const fieldName = sel.name.value;
    const schemaField = parentFields[fieldName];
    if (!schemaField) {
      throw new Error(
        `codegen: field "${fieldName}" missing on "${parentType.name}" in vendored SDL`,
      );
    }
    const rendered = renderType(schemaField.type as GraphQLOutputType);
    fields.push({
      name: sel.alias?.value ?? fieldName,
      tsType: rendered.tsType,
    });
    nested.push(...rendered.nestedObjects);
  }
  return {
    def: { name: interfaceName, fields },
    nestedObjects: nested,
  };
}

function unwrapNamedType(type: GraphQLType): GraphQLNamedType {
  let cur: GraphQLType = type;
  while (isNonNullType(cur) || isListType(cur)) {
    cur = cur.ofType;
  }
  return cur as GraphQLNamedType;
}

function emitInterface(def: InterfaceDef): string {
  if (def.fields.length === 0) {
    return `export interface ${def.name} {}\n`;
  }
  const body = def.fields
    .map((f) => `  ${jsKey(f.name)}: ${f.tsType};`)
    .join("\n");
  return `export interface ${def.name} {\n${body}\n}\n`;
}

function jsKey(name: string): string {
  // GraphQL field names are already valid JS identifiers, but quote
  // defensively in case a future spec extension allows otherwise.
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? name : JSON.stringify(name);
}

// ---------------------------------------------------------------------------
// Module emission
// ---------------------------------------------------------------------------

function escapeBacktickString(source: string): string {
  return source
    .replace(/\\/g, "\\\\")
    .replace(/`/g, "\\`")
    .replace(/\${/g, "\\${");
}

function emitOperationModule(
  schema: GraphQLSchema,
  op: OperationDefinitionNode,
  source: string,
): string {
  const opName = op.name?.value;
  if (!opName) throw new Error("codegen: operation must be named");

  // Variables interface (always emitted, even when zero variables).
  const vars = renderVariablesInterface(
    schema,
    opName,
    op.variableDefinitions ?? [],
  );

  // Response interface: walk the operation's selection set against
  // the schema's root type for this operation kind.
  const rootType =
    op.operation === "mutation"
      ? schema.getMutationType()
      : op.operation === "subscription"
        ? schema.getSubscriptionType()
        : schema.getQueryType();
  if (!rootType) {
    throw new Error(
      `codegen: SDL has no root type for ${op.operation} operations`,
    );
  }
  const topSelections = op.selectionSet.selections.filter(
    (s): s is FieldNode => s.kind === "Field",
  );
  const response = renderSelectionInterface(
    schema,
    `${opName}Response`,
    rootType,
    topSelections,
  );

  // Build a queue of nested object types to emit. Each entry is
  // `{ tsName, schemaType, selections }`.
  interface NestedQueueItem {
    interfaceName: string;
    schemaType: GraphQLObjectType;
    selections: readonly FieldNode[];
  }
  const nestedQueue: NestedQueueItem[] = [];
  collectNestedSelections(rootType, topSelections, nestedQueue);

  const nestedDefs: InterfaceDef[] = [];
  const seen = new Set<string>();
  while (nestedQueue.length > 0) {
    const item = nestedQueue.shift();
    if (!item) break;
    if (seen.has(item.interfaceName)) continue;
    seen.add(item.interfaceName);
    const rendered = renderSelectionInterface(
      schema,
      item.interfaceName,
      item.schemaType,
      item.selections,
    );
    nestedDefs.push(rendered.def);
    collectNestedSelections(item.schemaType, item.selections, nestedQueue);
  }

  // Render the module.
  const interfaces = [
    emitInterface(vars.def),
    ...nestedDefs.map(emitInterface),
    emitInterface(response.def),
  ].join("\n");

  const escaped = escapeBacktickString(source);

  return `// AUTO-GENERATED by scripts/graphql-codegen.ts — do not edit by hand.
// Types are DERIVED from src/lib/graphql/aimer.schema.graphql; an SDL
// change that affects this operation will regenerate the diff below.
// Re-run \`pnpm graphql:codegen\` after editing the corresponding
// operation file under src/lib/graphql/operations/, then commit both
// the .graphql source and the regenerated output in the same diff.

import type { TypedDocumentNode } from "@graphql-typed-document-node/core";
import { type DocumentNode, parse } from "graphql";

${interfaces}
export const ${camelToConst(opName)}_SOURCE = \`${escaped}\`;

const document: DocumentNode = parse(${camelToConst(opName)}_SOURCE);

export const ${opName}Document = document as unknown as TypedDocumentNode<
  ${opName}Response,
  ${opName}Variables
>;
`;
}

function camelToConst(name: string): string {
  // `AnalyzeEvent` -> `ANALYZE_EVENT`. The trailing `_SOURCE` is
  // appended by the caller.
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z])([A-Z][a-z])/g, "$1_$2")
    .toUpperCase();
}

function collectNestedSelections(
  parentType: GraphQLObjectType,
  selections: readonly FieldNode[],
  out: {
    interfaceName: string;
    schemaType: GraphQLObjectType;
    selections: readonly FieldNode[];
  }[],
): void {
  const parentFields = parentType.getFields();
  for (const sel of selections) {
    if (!sel.selectionSet) continue;
    const fieldDef = parentFields[sel.name.value];
    if (!fieldDef) continue;
    const named = unwrapNamedType(fieldDef.type);
    if (named instanceof GraphQLObjectTypeClass) {
      out.push({
        interfaceName: named.name,
        schemaType: named,
        selections: sel.selectionSet.selections.filter(
          (s): s is FieldNode => s.kind === "Field",
        ),
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Top-level orchestration
// ---------------------------------------------------------------------------

function runCodegen(outDir: string): CodegenResult {
  const sdlSource = readFileSync(SDL_PATH, "utf-8");
  const schema = buildSchema(sdlSource);

  const files = new Map<string, string>();
  const entries = readdirSync(OPERATIONS_DIR, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".graphql")) continue;

    const opSource = readFileSync(join(OPERATIONS_DIR, entry.name), "utf-8");

    let document: DocumentNode;
    try {
      document = parse(opSource);
    } catch (err) {
      throw new Error(
        `codegen: failed to parse ${entry.name}: ${(err as Error).message}`,
      );
    }

    const errors = validate(schema, document);
    if (errors.length > 0) {
      throw new Error(
        `codegen: ${entry.name} does not validate against the vendored SDL:\n` +
          errors.map((e) => `  - ${e.message}`).join("\n"),
      );
    }

    const ops = document.definitions.filter(
      (d): d is OperationDefinitionNode => d.kind === "OperationDefinition",
    );
    if (ops.length !== 1) {
      throw new Error(
        `codegen: ${entry.name} must contain exactly one named operation, got ${ops.length}`,
      );
    }

    const moduleSource = emitOperationModule(schema, ops[0], opSource);
    const baseName = basename(entry.name, ".graphql");
    files.set(join(outDir, `${baseName}.ts`), moduleSource);
  }

  return { files };
}

function writeFiles(files: Map<string, string>): void {
  for (const [path, content] of files) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content, "utf-8");
  }
}

/**
 * `pnpm graphql:check` mode: compare in-memory codegen output against
 * the committed files under `DEFAULT_OUT_DIR`. Exit non-zero on drift
 * so CI surfaces the missing regeneration.
 */
function checkAgainstCommitted(): void {
  const { files } = runCodegen(DEFAULT_OUT_DIR);
  const drift: string[] = [];
  for (const [path, expected] of files) {
    let actual: string;
    try {
      actual = readFileSync(path, "utf-8");
    } catch {
      drift.push(`  - missing: ${path}`);
      continue;
    }
    if (actual !== expected) drift.push(`  - out of sync: ${path}`);
  }
  if (drift.length > 0) {
    console.error(
      "graphql:check failed — committed generated files drift from the " +
        "current `.graphql` operations + vendored SDL.\nRun `pnpm graphql:codegen` " +
        "and commit the result.\n" +
        drift.join("\n"),
    );
    process.exit(1);
  }
  console.log(
    `graphql:check OK (${files.size} operation${files.size === 1 ? "" : "s"})`,
  );
}

function main(): void {
  const mode = process.argv[2] ?? "write";
  if (mode === "check") {
    checkAgainstCommitted();
    return;
  }
  if (mode === "write") {
    const { files } = runCodegen(DEFAULT_OUT_DIR);
    writeFiles(files);
    console.log(
      `graphql:codegen wrote ${files.size} file${files.size === 1 ? "" : "s"}`,
    );
    return;
  }
  console.error(`unknown mode: ${mode} (expected "write" or "check")`);
  process.exit(2);
}

main();
