// Query-string merge helper (parent #386 "query preservation").
//
// Navigation that changes one concern (e.g. the customer scope) must
// preserve the other report-variant params already on the URL
// (`?tz=&lang=&model_name=&model=`) rather than replacing the whole query
// string. This helper merges a set of updates into the current params:
//   - a string value sets/overwrites the key;
//   - a `null`/`undefined`/empty-string value removes the key entirely.
// Only the keys named in `updates` are touched; every other existing param
// (including legitimately-empty ones) is carried through untouched.
//
// The output keys are sorted so the resulting query string is
// deterministic and shareable links are stable.

type CurrentQuery =
  | string
  | URLSearchParams
  // Next's `ReadonlyURLSearchParams` is structurally a URLSearchParams with
  // a `toString()`; accept anything that can stringify to a query string.
  | { toString(): string }
  | null
  | undefined;

export function mergeQuery(
  current: CurrentQuery,
  updates: Record<string, string | null | undefined>,
): string {
  const raw =
    typeof current === "string"
      ? current.replace(/^\?/, "")
      : (current?.toString() ?? "");
  const params = new URLSearchParams(raw);

  for (const [key, value] of Object.entries(updates)) {
    if (value == null || value === "") {
      params.delete(key);
    } else {
      params.set(key, value);
    }
  }

  params.sort();
  return params.toString();
}
