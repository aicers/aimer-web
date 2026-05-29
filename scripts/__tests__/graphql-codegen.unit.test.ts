import { buildSchema, type OperationDefinitionNode, parse } from "graphql";
import { describe, expect, it } from "vitest";

import { emitOperationModule } from "../graphql-codegen";

// Minimal SDL that mirrors the shape RFC 0002 #344 introduced: a
// mutation whose variables are input objects, one of which nests a
// list-of-input-objects field, plus a nullable input field to exercise
// the optionality path.
const SDL = /* GraphQL */ `
  scalar DateTime

  enum Language {
    KOREAN
    ENGLISH
  }

  input StoryRoleCountInput {
    role: String!
    count: Int!
  }

  input StoryMetadataInput {
    storyId: ID!
    memberCount: Int!
    roleDistribution: [StoryRoleCountInput!]!
  }

  input StoryMemberInput {
    ordinal: Int!
    role: String!
    eventTime: DateTime!
    event: String!
    "Nullable input field — must render as an optional property."
    note: String
  }

  type StoryAnalysisResult {
    severityScore: Float!
  }

  type Query {
    _: Boolean
  }

  type Mutation {
    analyzeStory(
      members: [StoryMemberInput!]!
      storyMetadata: StoryMetadataInput!
      lang: Language
    ): StoryAnalysisResult!
  }
`;

const OPERATION = /* GraphQL */ `mutation AnalyzeStory(
  $members: [StoryMemberInput!]!
  $storyMetadata: StoryMetadataInput!
  $lang: Language
) {
  analyzeStory(members: $members, storyMetadata: $storyMetadata, lang: $lang) {
    severityScore
  }
}`;

function emit(): string {
  const schema = buildSchema(SDL);
  const doc = parse(OPERATION);
  const op = doc.definitions.find(
    (d): d is OperationDefinitionNode => d.kind === "OperationDefinition",
  );
  if (!op) throw new Error("test setup: no operation in document");
  return emitOperationModule(schema, op, OPERATION);
}

describe("emitOperationModule — input-object rendering", () => {
  it("emits an interface for each input object referenced by the variables", () => {
    const out = emit();
    expect(out).toContain(
      [
        "export interface StoryMemberInput {",
        "  ordinal: number;",
        "  role: string;",
        "  eventTime: string;",
        "  event: string;",
        "  note?: string | null;",
        "}",
      ].join("\n"),
    );
    expect(out).toContain(
      [
        "export interface StoryMetadataInput {",
        "  storyId: string;",
        "  memberCount: number;",
        "  roleDistribution: Array<StoryRoleCountInput>;",
        "}",
      ].join("\n"),
    );
  });

  it("recurses into nested input objects (roleDistribution → StoryRoleCountInput)", () => {
    const out = emit();
    // `StoryRoleCountInput` is never a direct variable — it is only
    // reachable through `StoryMetadataInput.roleDistribution`. Its
    // interface must still be emitted via the BFS over nested inputs.
    expect(out).toContain(
      [
        "export interface StoryRoleCountInput {",
        "  role: string;",
        "  count: number;",
        "}",
      ].join("\n"),
    );
  });

  it("renders a nullable input field as an optional property", () => {
    const out = emit();
    expect(out).toContain("  note?: string | null;");
    // Non-null fields must NOT be optional.
    expect(out).toContain("  ordinal: number;");
    expect(out).not.toContain("ordinal?:");
  });

  it("references input objects from the variables interface", () => {
    const out = emit();
    expect(out).toContain(
      [
        "export interface AnalyzeStoryVariables {",
        "  members: Array<StoryMemberInput>;",
        "  storyMetadata: StoryMetadataInput;",
        '  lang?: "KOREAN" | "ENGLISH" | null;',
        "}",
      ].join("\n"),
    );
  });

  it("emits each input object exactly once even when reachable by multiple paths", () => {
    const out = emit();
    const count = (needle: string) => out.split(needle).length - 1;
    expect(count("export interface StoryMemberInput {")).toBe(1);
    expect(count("export interface StoryMetadataInput {")).toBe(1);
    expect(count("export interface StoryRoleCountInput {")).toBe(1);
  });
});
