import type { AbstractIntlMessages } from "use-intl";

export type FlatMessages = Record<string, string>;
export type NestedMessages = AbstractIntlMessages;

/**
 * Convert flat message keys into the nested object shape expected by next-intl/use-intl.
 *
 * Rationale:
 * - We store messages as flat JSON (e.g., "signin.title") for simpler editing,
 *   easier sorting, and AI-friendly generation.
 * - next-intl validates that message objects are nested (dots indicate levels),
 *   so we transform the flat map at request time before providing messages.
 * - Example: {"signin.title": "Sign In"} becomes {signin: {title: "Sign In"}}.
 */
export function nestMessages(flat: FlatMessages): NestedMessages {
  const out: NestedMessages = {};
  for (const [key, value] of Object.entries(flat)) {
    const parts = key.split(".");
    let cursor = out as Record<string, unknown>;
    for (let i = 0; i < parts.length - 1; i++) {
      const segment = parts[i];
      const next = cursor[segment];
      if (typeof next !== "object" || next === null) {
        cursor[segment] = {} as NestedMessages;
      }
      cursor = cursor[segment] as Record<string, unknown>;
    }
    cursor[parts[parts.length - 1]] = value;
  }
  return out;
}
