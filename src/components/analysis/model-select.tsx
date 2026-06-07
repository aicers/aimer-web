"use client";

// Analyst-only model dropdown shared by the report and story regenerate
// modals (#458). The catalog reaches this client component as serializable
// props from the server page (`model-catalog.ts` is server-only and must
// never be imported here). Option values are array indices so a `modelName` /
// `model` that happens to contain a separator character cannot break parsing.

export interface ModelOption {
  modelName: string;
  model: string;
  label: string;
}

export function ModelSelect({
  id,
  label,
  models,
  selectedIndex,
  onSelect,
  disabled,
}: {
  id: string;
  label: string;
  models: ModelOption[];
  selectedIndex: number;
  onSelect: (index: number) => void;
  disabled?: boolean;
}) {
  return (
    <div className="mb-4">
      <label
        htmlFor={id}
        className="mb-1 block text-xs font-medium uppercase tracking-wide text-muted-foreground"
      >
        {label}
      </label>
      <select
        id={id}
        data-testid="model-select"
        value={selectedIndex}
        disabled={disabled}
        onChange={(e) => onSelect(Number(e.target.value))}
        className="w-full rounded border border-border bg-card px-3 py-2 text-sm text-foreground disabled:opacity-60"
      >
        {models.map((m, i) => (
          <option key={`${m.modelName}/${m.model}`} value={i}>
            {m.label}
          </option>
        ))}
      </select>
    </div>
  );
}

/**
 * Resolve the initial dropdown index: the preferred `(modelName, model)` pair
 * if present in the catalog, otherwise the first entry. Used to preselect the
 * current variant's model — or, for the compare "not generated" CTA, the
 * compare-target model (#458).
 */
export function initialModelIndex(
  models: ModelOption[],
  preferred: { modelName?: string; model?: string } | undefined,
): number {
  if (!preferred?.modelName || !preferred?.model) return 0;
  const i = models.findIndex(
    (m) => m.modelName === preferred.modelName && m.model === preferred.model,
  );
  return i >= 0 ? i : 0;
}
