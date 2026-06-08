// Single source of truth for the analyst-facing model allow-list (#458).
//
// `model_name` / `model` were previously free-form strings defaulting to
// `ANALYSIS_DEFAULT_MODEL_NAME` / `ANALYSIS_DEFAULT_MODEL`, read ad hoc in
// loaders, workers, and the regenerate routes. This module centralizes the
// set of `(model_name, model)` pairs the regenerate model picker and the
// side-by-side compare view may offer / submit.
//
// SERVER-ONLY. `ANALYSIS_MODEL_CATALOG` is a non-`NEXT_PUBLIC` env var, so the
// catalog can only be read on the server. A client component MUST NOT import
// this module (it would read `undefined` in the browser); the server page /
// loader reads the catalog and passes the resolved, serializable entries down
// as props. Catalog enforcement is a UI concern only — the regenerate
// endpoints stay tolerant of their existing inputs (Scope 1 / 4).

import "server-only";

const DEFAULT_MODEL_NAME = process.env.ANALYSIS_DEFAULT_MODEL_NAME ?? "openai";
const DEFAULT_MODEL = process.env.ANALYSIS_DEFAULT_MODEL ?? "gpt-4o";

/**
 * One offered model variant. `modelName` / `model` are the variant-axis pair
 * the regenerate endpoints accept (`?model_name=&model=`); `label` is the
 * analyst-facing display string for the picker dropdown.
 */
export interface ModelCatalogEntry {
  modelName: string;
  model: string;
  label: string;
}

// Built-in fallback label for a pair the env JSON did not name.
function fallbackLabel(modelName: string, model: string): string {
  return `${modelName} / ${model}`;
}

// The configured default pair, always present in the catalog (Scope 1).
function defaultEntry(): ModelCatalogEntry {
  return {
    modelName: DEFAULT_MODEL_NAME,
    model: DEFAULT_MODEL,
    label: fallbackLabel(DEFAULT_MODEL_NAME, DEFAULT_MODEL),
  };
}

const pairKey = (modelName: string, model: string): string =>
  JSON.stringify([modelName, model]);

// Parse failures are logged once per process so a misconfigured env does not
// spam the request log on every page load.
let warnedInvalid = false;
function warnOnceInvalid(detail: string): void {
  if (warnedInvalid) return;
  warnedInvalid = true;
  console.warn(
    `[model-catalog] invalid ANALYSIS_MODEL_CATALOG (${detail}); ` +
      "falling back to the default model only",
  );
}

// Validate one parsed env entry. Entries missing `modelName`/`model` make the
// whole env value invalid (Scope 1 parsing contract); `label` is optional and
// falls back to the built-in label when absent or non-string.
function toEntry(raw: unknown): ModelCatalogEntry | null {
  if (raw === null || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  const modelName = obj.modelName;
  const model = obj.model;
  if (typeof modelName !== "string" || modelName.length === 0) return null;
  if (typeof model !== "string" || model.length === 0) return null;
  const label =
    typeof obj.label === "string" && obj.label.length > 0
      ? obj.label
      : fallbackLabel(modelName, model);
  return { modelName, model, label };
}

/**
 * Resolve the catalog from `ANALYSIS_MODEL_CATALOG` per the Scope 1 contract:
 *   - JSON array of `{ modelName, model, label }` objects.
 *   - The configured default pair is always present, prepended if missing; if
 *     present in the env JSON its supplied `label` wins, otherwise the
 *     built-in fallback label is used.
 *   - Entries are deduped by `(modelName, model)`, first occurrence wins,
 *     original order preserved.
 *   - Malformed JSON or any entry missing `modelName`/`model` falls back to
 *     the default pair only (logged once) rather than throwing.
 */
function resolveCatalog(): ModelCatalogEntry[] {
  const rawEnv = process.env.ANALYSIS_MODEL_CATALOG;
  if (rawEnv === undefined || rawEnv.trim().length === 0) {
    return [defaultEntry()];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawEnv);
  } catch {
    warnOnceInvalid("not valid JSON");
    return [defaultEntry()];
  }
  if (!Array.isArray(parsed)) {
    warnOnceInvalid("not a JSON array");
    return [defaultEntry()];
  }

  const entries: ModelCatalogEntry[] = [];
  for (const raw of parsed) {
    const entry = toEntry(raw);
    if (!entry) {
      warnOnceInvalid("entry missing modelName/model");
      return [defaultEntry()];
    }
    entries.push(entry);
  }

  // Dedup by pair, first occurrence wins, original order preserved.
  const seen = new Set<string>();
  const deduped: ModelCatalogEntry[] = [];
  for (const entry of entries) {
    const key = pairKey(entry.modelName, entry.model);
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(entry);
  }

  // The default pair is always present; prepend it only when the env JSON did
  // not already include it (in which case its env-supplied label is kept).
  if (!seen.has(pairKey(DEFAULT_MODEL_NAME, DEFAULT_MODEL))) {
    deduped.unshift(defaultEntry());
  }
  return deduped;
}

// Resolved once at module load — the env is fixed for the process lifetime.
let cached: ModelCatalogEntry[] | null = null;

/**
 * The ENV-level default `(modelName, model)` pair — the third/last tier
 * of the #473 resolution order and the pair `ANALYSIS_MODEL_CATALOG`
 * always contains.
 *
 * RE-SCOPED for #473: this is NO LONGER the source of truth for "the
 * default model a given customer uses". That is now per-customer and
 * resolved asynchronously by `resolveDefaultModel(customerId)`
 * (`default-model.ts`), which layers a per-customer override and an
 * admin-set global default on top of this env pair. Use this getter
 * ONLY for env/catalog allow-list duties (e.g. the pair guaranteed to be
 * in the catalog); use `resolveDefaultModel` wherever a customer's
 * effective default — including the #379/#465 "default report → full
 * leaf coverage" decision — is needed, so the coverage logic and the
 * resolver never disagree. Server-only, like the rest of this module.
 */
export function getDefaultModelPair(): { modelName: string; model: string } {
  return { modelName: DEFAULT_MODEL_NAME, model: DEFAULT_MODEL };
}

/**
 * The ordered model allow-list the picker offers and the only pairs it may
 * submit. Always includes the configured default pair.
 */
export function getModelCatalog(): ModelCatalogEntry[] {
  if (cached === null) cached = resolveCatalog();
  // Return a fresh array so callers cannot mutate the cached catalog.
  return cached.map((e) => ({ ...e }));
}

/**
 * Whether `(modelName, model)` is an allowed catalog pair. The picker uses
 * this as its UI-side allow-list; it is NOT a server-side enforcement on the
 * regenerate endpoints (those stay tolerant of their existing inputs).
 */
export function isModelAllowed(modelName: string, model: string): boolean {
  const key = pairKey(modelName, model);
  return getModelCatalog().some((e) => pairKey(e.modelName, e.model) === key);
}

// Test-only: reset the memoized catalog + one-shot warn flag so a test can
// exercise different `ANALYSIS_MODEL_CATALOG` values in one process.
export function __resetModelCatalogForTest(): void {
  cached = null;
  warnedInvalid = false;
}
