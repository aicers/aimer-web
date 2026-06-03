// Language-code boundary mapping (#389 / parent #386 "Language codes").
//
// Two distinct vocabularies coexist and must never be mixed inside one
// layer:
//   - the app UI *locale* (`en` / `ko`) — URL prefix, `accounts.locale`,
//     next-intl, and the global `DEFAULT_LOCALE` env;
//   - the aimer `Language` enum / report-leaf `lang` variant column
//     (`ENGLISH` / `KOREAN`).
//
// Convert only at the loader/API/worker boundary via `localeToLanguage`.
// English is the guaranteed baseline, so an unknown/garbled locale maps to
// `ENGLISH` rather than throwing — callers that need strict validation do
// it before calling.

export type Locale = "en" | "ko";
export type Language = "ENGLISH" | "KOREAN";

const LOCALE_TO_LANGUAGE: Record<Locale, Language> = {
  en: "ENGLISH",
  ko: "KOREAN",
};

/**
 * Map an app UI locale (`en` / `ko`) to the aimer `Language` enum
 * (`ENGLISH` / `KOREAN`). Falls back to the English baseline for any value
 * outside the known locale set.
 */
export function localeToLanguage(locale: string): Language {
  return LOCALE_TO_LANGUAGE[locale as Locale] ?? "ENGLISH";
}
