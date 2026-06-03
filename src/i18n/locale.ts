import { routing } from "./routing";

/** Supported app locales — URL prefix, `accounts.locale`, next-intl. */
export type AppLocale = (typeof routing.locales)[number];

/**
 * The aimer `Language` enum / report `lang` variant vocabulary. The app
 * locale (`en`/`ko`) and the report language (`ENGLISH`/`KOREAN`) are
 * deliberately separate vocabularies — map only at the loader/API
 * boundary (see #386 shared contracts), never mix them inside one layer.
 */
export type ReportLanguage = "ENGLISH" | "KOREAN";

const LOCALE_TO_REPORT_LANGUAGE: Record<AppLocale, ReportLanguage> = {
  en: "ENGLISH",
  ko: "KOREAN",
};

const REPORT_LANGUAGE_TO_LOCALE: Record<ReportLanguage, AppLocale> = {
  ENGLISH: "en",
  KOREAN: "ko",
};

/** Narrow an arbitrary value to a supported app locale. */
export function isSupportedLocale(value: unknown): value is AppLocale {
  return (
    typeof value === "string" &&
    (routing.locales as readonly string[]).includes(value)
  );
}

/**
 * Map an app locale (`en`/`ko`) to a report language (`ENGLISH`/`KOREAN`).
 *
 * This is the single canonical forward mapper for the locale↔language
 * boundary (#388 consolidation — the duplicated `localeToLanguage` in the
 * former `i18n/language.ts` has been removed). It is intentionally TYPED on
 * `AppLocale` rather than `string`, so it never silently folds an unknown
 * value to English: callers that hold an untrusted string (a `?lang` query
 * value, a `DEFAULT_LOCALE` env value) must validate with
 * {@link isSupportedLocale} first and choose the English baseline themselves.
 */
export function appLocaleToReportLanguage(locale: AppLocale): ReportLanguage {
  return LOCALE_TO_REPORT_LANGUAGE[locale];
}

/** Map a report language (`ENGLISH`/`KOREAN`) back to an app locale. */
export function reportLanguageToAppLocale(language: ReportLanguage): AppLocale {
  return REPORT_LANGUAGE_TO_LOCALE[language];
}

/**
 * Validate that a value is a real IANA time zone, using the runtime's
 * own zone database. `accounts.timezone` is not CHECK-constrained at the
 * DB level (the IANA set is large and runtime-dependent), so this is the
 * authoritative validation for self-service writes.
 */
export function isValidTimeZone(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0) {
    return false;
  }
  try {
    // Throws RangeError for an unknown zone.
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}
