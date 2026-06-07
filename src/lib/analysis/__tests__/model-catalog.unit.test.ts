// Unit tests for the model catalog parsing contract (#458 Scope 1/6):
// default-included, dedup, original-order preservation, and the invalid-env
// fallback (malformed JSON / entry missing modelName/model → default only,
// logged once).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const ENV_KEY = "ANALYSIS_MODEL_CATALOG";

async function load() {
  const mod = await import("../model-catalog");
  mod.__resetModelCatalogForTest();
  return mod;
}

describe("model-catalog", () => {
  const original = process.env[ENV_KEY];

  beforeEach(() => {
    // The default pair is read at module load from these vars; the test
    // process leaves them at the built-in defaults (openai / gpt-4o).
    delete process.env[ENV_KEY];
  });
  afterEach(() => {
    if (original === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = original;
    vi.restoreAllMocks();
  });

  it("returns the default pair only when the env var is unset", async () => {
    const { getModelCatalog, isModelAllowed } = await load();
    expect(getModelCatalog()).toEqual([
      { modelName: "openai", model: "gpt-4o", label: "openai / gpt-4o" },
    ]);
    expect(isModelAllowed("openai", "gpt-4o")).toBe(true);
    expect(isModelAllowed("anthropic", "claude-3-5-sonnet")).toBe(false);
  });

  it("prepends the default pair when the env JSON omits it", async () => {
    process.env[ENV_KEY] = JSON.stringify([
      { modelName: "anthropic", model: "claude", label: "Claude" },
    ]);
    const { getModelCatalog } = await load();
    expect(getModelCatalog()).toEqual([
      { modelName: "openai", model: "gpt-4o", label: "openai / gpt-4o" },
      { modelName: "anthropic", model: "claude", label: "Claude" },
    ]);
  });

  it("keeps the env-supplied label + position when the default appears", async () => {
    process.env[ENV_KEY] = JSON.stringify([
      { modelName: "anthropic", model: "claude", label: "Claude" },
      { modelName: "openai", model: "gpt-4o", label: "Custom GPT-4o" },
    ]);
    const { getModelCatalog } = await load();
    expect(getModelCatalog()).toEqual([
      { modelName: "anthropic", model: "claude", label: "Claude" },
      { modelName: "openai", model: "gpt-4o", label: "Custom GPT-4o" },
    ]);
  });

  it("dedupes by (modelName, model), first occurrence wins, order preserved", async () => {
    process.env[ENV_KEY] = JSON.stringify([
      { modelName: "openai", model: "gpt-4o", label: "First" },
      { modelName: "anthropic", model: "claude", label: "Claude" },
      { modelName: "openai", model: "gpt-4o", label: "Duplicate" },
    ]);
    const { getModelCatalog } = await load();
    expect(getModelCatalog()).toEqual([
      { modelName: "openai", model: "gpt-4o", label: "First" },
      { modelName: "anthropic", model: "claude", label: "Claude" },
    ]);
  });

  it("falls back to the default pair on malformed JSON, logging once", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    process.env[ENV_KEY] = "{not json";
    const { getModelCatalog } = await load();
    expect(getModelCatalog()).toEqual([
      { modelName: "openai", model: "gpt-4o", label: "openai / gpt-4o" },
    ]);
    // Second resolve must not re-log (warn-once).
    getModelCatalog();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("falls back to the default pair when an entry misses modelName/model", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    process.env[ENV_KEY] = JSON.stringify([
      { modelName: "anthropic", model: "claude", label: "Claude" },
      { modelName: "broken", label: "no model" },
    ]);
    const { getModelCatalog, isModelAllowed } = await load();
    expect(getModelCatalog()).toEqual([
      { modelName: "openai", model: "gpt-4o", label: "openai / gpt-4o" },
    ]);
    expect(isModelAllowed("anthropic", "claude")).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("falls back when the parsed JSON is not an array", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    process.env[ENV_KEY] = JSON.stringify({ modelName: "x", model: "y" });
    const { getModelCatalog } = await load();
    expect(getModelCatalog()).toEqual([
      { modelName: "openai", model: "gpt-4o", label: "openai / gpt-4o" },
    ]);
  });
});
