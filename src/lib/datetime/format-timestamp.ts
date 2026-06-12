/**
 * Central, pure timestamp-formatting utility (#400).
 *
 * Input instants are always UTC (`TIMESTAMPTZ`, RFC 3339 with offset).
 * User-facing timestamps are displayed in the resolution order
 * `accounts.timezone` → browser timezone → UTC — parallel to the language
 * resolution order (parent #386 "Timestamp display timezone" contract).
 *
 * This module does NOT fetch anything: the caller (the `<Timestamp>`
 * component / its provider) supplies the account timezone, which keeps the
 * util usable from both the dashboard and admin auth contexts. The display
 * timezone is *distinct* from the report bucket tz (`customers.timezone`,
 * which defines DAILY/WEEKLY/MONTHLY bucket boundaries and is report
 * identity) — bucket tz is unchanged; this only localizes the display of
 * individual instants.
 */

/** Whether `tz` is an IANA timezone `Intl` accepts (a bad value throws). */
export function isValidTimeZone(tz: string): boolean {
  if (!tz) return false;
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** The browser/runtime timezone, or `undefined` if it cannot be read. */
function getRuntimeTimeZone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Resolve the display timezone as `accountTimezone` → browser/runtime
 * timezone → `UTC`. Each candidate must be a valid IANA zone to be used;
 * an invalid one is skipped rather than allowed to throw downstream.
 *
 * `browserTimeZone` is injectable so the resolution order is testable
 * without depending on the host's actual zone; when omitted it is read
 * from `Intl.DateTimeFormat().resolvedOptions().timeZone`.
 */
export function resolveDisplayTimeZone(
  accountTimezone: string | null | undefined,
  browserTimeZone: string | undefined = getRuntimeTimeZone(),
): string {
  if (accountTimezone && isValidTimeZone(accountTimezone)) {
    return accountTimezone;
  }
  if (browserTimeZone && isValidTimeZone(browserTimeZone)) {
    return browserTimeZone;
  }
  return "UTC";
}

// ---------------------------------------------------------------------------
// User-selectable display format (#556)
//
// The format is exposed as a small set of orthogonal, `Intl`-backed options
// whose combinations produce many concrete formats. Format resolution lives in
// ONE place: the formatters below accept a single resolved options object, the
// account preference is resolved into that object by {@link resolveTimeFormat},
// and call sites never spread individual options. The default object equals the
// current aice-matched options, so behaviour is unchanged when no preference is
// set.
// ---------------------------------------------------------------------------

/** The 12-hour / 24-hour choice, mirroring `Intl`'s `hourCycle` values. */
export type TimeFormatHourCycle = "h12" | "h23";

/**
 * The literal sentinel stored in `accounts.time_format_locale` meaning "follow
 * the active app locale" (as opposed to `null` = follow the browser, or an
 * explicit BCP-47 tag). It is not a real BCP-47 tag, so it cannot collide with
 * an entry of {@link TIME_FORMAT_LOCALES}.
 */
export const TIME_FORMAT_LOCALE_APP = "app";

/**
 * Curated BCP-47 tags offered as explicit formatting locales. The set is
 * deliberately small and orthogonal to the other options — each tag drives
 * date order, separators, and AM/PM wording (e.g. `en-US` `6/3/2026, 2:05:30
 * PM`, `en-CA` `2026-06-03, 2:05:30 p.m.`, `en-GB` `03/06/2026, 14:05:30`,
 * `ko-KR` `2026. 6. 3. 오후 2:05:30`). Month *names* never appear: the
 * formatters use `month: "numeric"`. The preferences `PATCH` rejects any
 * locale value outside this list plus the `'app'` sentinel.
 */
export const TIME_FORMAT_LOCALES = [
  "en-US",
  "en-CA",
  "en-GB",
  "en-AU",
  "en-IN",
  "ko-KR",
  "ja-JP",
  "zh-CN",
  "zh-TW",
  "de-DE",
  "fr-FR",
  "fr-CA",
  "es-ES",
  "pt-BR",
  "it-IT",
  "nl-NL",
  "ru-RU",
  "sv-SE",
] as const;

/** Whether `value` is a valid stored `time_format_locale` (sentinel/tag). */
export function isTimeFormatLocale(value: unknown): boolean {
  return (
    value === TIME_FORMAT_LOCALE_APP ||
    (typeof value === "string" &&
      (TIME_FORMAT_LOCALES as readonly string[]).includes(value))
  );
}

/**
 * The account's stored format preference, exactly as persisted / returned by
 * the `me` endpoints. Every field is nullable; `null` uniformly means "use the
 * app default", so "user never touched the setting" stays distinguishable from
 * an explicit choice.
 */
export interface StoredTimeFormat {
  /** `null` = follow browser, `'app'` = follow app locale, else a BCP-47 tag. */
  locale: string | null;
  /** `null` = follow the locale's default. */
  hourCycle: TimeFormatHourCycle | null;
  /** `null` = default (show). */
  seconds: boolean | null;
  /** `null` = default (hide). */
  tzLabel: boolean | null;
}

/**
 * The resolved options the formatters consume. Produced by
 * {@link resolveTimeFormat}; the {@link DEFAULT_TIME_FORMAT} value reproduces
 * the current aice-matched output.
 */
export interface ResolvedTimeFormat {
  /** Locale for the general format; `undefined` = follow the browser. */
  locale: string | undefined;
  /** `undefined` = follow the locale's default. */
  hourCycle: TimeFormatHourCycle | undefined;
  seconds: boolean;
  tzLabel: boolean;
}

/**
 * The default resolved options — equal to the aice-matched general format
 * (#553): browser locale, locale-default hour cycle, seconds shown, no
 * timezone label. Passing this (or omitting the options) keeps the output
 * byte-identical to the pre-#556 behaviour.
 */
export const DEFAULT_TIME_FORMAT: ResolvedTimeFormat = {
  locale: undefined,
  hourCycle: undefined,
  seconds: true,
  tzLabel: false,
};

/**
 * Resolve the stored account preference into a {@link ResolvedTimeFormat},
 * threading the active app locale through the `'app'` sentinel. `null`/absent
 * input yields {@link DEFAULT_TIME_FORMAT}. This is the single point where the
 * preference becomes concrete `Intl` options.
 */
export function resolveTimeFormat(
  stored: StoredTimeFormat | null | undefined,
  appLocale: string,
): ResolvedTimeFormat {
  if (!stored) return DEFAULT_TIME_FORMAT;
  let locale: string | undefined;
  if (stored.locale === null || stored.locale === undefined) {
    locale = undefined; // follow the browser
  } else if (stored.locale === TIME_FORMAT_LOCALE_APP) {
    locale = appLocale; // follow the active app locale
  } else {
    locale = stored.locale; // an explicit BCP-47 tag
  }
  return {
    locale,
    hourCycle: stored.hourCycle ?? undefined,
    seconds: stored.seconds ?? true,
    tzLabel: stored.tzLabel ?? false,
  };
}

/**
 * Format a UTC instant in an already-resolved display `timeZone` as a
 * general, locale-aware date-time. With the default options it is byte-
 * identical to aice-web-next's `formatDateTime` (`src/lib/format-date.ts`)
 * for the same `(instant, timezone)`: it follows the **browser** locale
 * (`undefined`), includes seconds, is 12-hour where the locale dictates, and
 * carries no timezone label — e.g. EN `6/3/2026, 2:05:30 PM`, KO `2026. 6. 3.
 * 오후 2:05:30`.
 *
 * The `options` object carries the resolved account preference (#556); it
 * defaults to {@link DEFAULT_TIME_FORMAT} so the aice parity holds when no
 * preference is set. Because the default result depends on the browser locale
 * (unknown on the server), the `<Timestamp>` component renders a deterministic
 * placeholder pre-mount and switches to this only after mount (#555).
 */
export function formatDateTime(
  date: string | Date,
  timezone?: string | null,
  options: ResolvedTimeFormat = DEFAULT_TIME_FORMAT,
): string {
  const d = typeof date === "string" ? new Date(date) : date;
  return d.toLocaleString(options.locale ?? undefined, {
    timeZone: timezone ?? undefined,
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    ...(options.seconds ? { second: "numeric" } : {}),
    ...(options.hourCycle ? { hourCycle: options.hourCycle } : {}),
    // `shortOffset` pins the label to the offset form (`GMT+9`); `short` can
    // yield locale/runtime-dependent abbreviations like `KST`/`PST`.
    ...(options.tzLabel ? { timeZoneName: "shortOffset" } : {}),
  });
}

/** The `Intl` knobs the compact form honours from the account preference. */
export interface CompactTimeFormatOptions {
  hourCycle?: TimeFormatHourCycle;
}

/**
 * Format a UTC instant in an already-resolved display `timeZone` as a
 * compact date-time for tight surfaces (breadcrumbs, event rows). With the
 * default options it is byte-identical to aice-web-next's
 * `formatDateTimeCompact`: it follows the **active app** `locale` and drops
 * year and seconds — e.g. EN `6/3, 2:05 PM`, KO `6. 3. 오후 2:05`.
 *
 * The compact form is purpose-built and honours **locale and hour cycle
 * only**: the year, the seconds, and the timezone label are ALWAYS omitted
 * regardless of the account's general-format preference, so a wide label can
 * never defeat compactness on tight surfaces (#556). The `locale` is passed in
 * explicitly (the caller resolves the preference against `useLocale()`).
 */
export function formatDateTimeCompact(
  date: string | Date,
  timezone?: string | null,
  locale?: string | null,
  options: CompactTimeFormatOptions = {},
): string {
  const d = typeof date === "string" ? new Date(date) : date;
  return d.toLocaleString(locale ?? undefined, {
    timeZone: timezone ?? undefined,
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    ...(options.hourCycle ? { hourCycle: options.hourCycle } : {}),
  });
}

// ---------------------------------------------------------------------------
// Reserved placeholder width (#555, extended for #556)
//
// `<Timestamp>` reserves a worst-case width so swapping the pre-mount
// placeholder for the resolved value never shifts the line. The chosen format
// changes the worst case (24-hour + seconds + timezone label is widest; ko's
// `h23` general form spells out 시/분/초, wider still), so the width is
// recomputed from the resolved options rather than hard-coded.
// ---------------------------------------------------------------------------

/**
 * A string's horizontal footprint in `ch`. `1ch` is the advance of "0", so a
 * digit is exactly `1ch`; a Korean `오전`/`오후`/`시` marker is full-width
 * (~2× a digit), so CJK/Hangul glyphs count as 2 and everything else as 1.
 * Narrow `.`/`:`/space separators counting as a full `1ch` only adds headroom.
 */
export function footprintCh(value: string): number {
  let width = 0;
  for (const ch of value) {
    width += /[ᄀ-ᇿ　-〿㄰-㆏一-鿿가-힯＀-￯]/u.test(ch) ? 2 : 1;
  }
  return width;
}

// The worst-case instant/zone for sizing: 2026-12-31 23:59:59 in Asia/Seoul
// gives two-digit month/day, two-digit 24-hour, a 12-hour PM marker, and
// (for ko `h23`) the full-width 시/분/초 spelling — the widest fields.
const WORST_INSTANT = new Date("2026-12-31T14:59:59Z");
const WORST_TZ = "Asia/Seoul";

// `reservedWidthCh` is pure in `(mode, resolved options)` but runs on every
// `<Timestamp>` render, and those inputs are highly repetitive across the app
// (one resolved preference shared by every timestamp). Memoize on the option
// tuple so the `Intl` sizing work happens once per distinct format, not once
// per rendered timestamp.
const reservedWidthCache = new Map<string, number>();

/**
 * The `ch` width to reserve for the `<Timestamp>` slot under the given mode and
 * resolved options. When the locale follows the browser/app (`undefined`), the
 * actual locale is unknown at sizing time, so the global worst case across the
 * full curated locale set is measured — not just `en`/`ko`. Those two are not
 * the widest: a `fr-CA` browser spells the time out (`11 h 59 min 59 s`), wider
 * than the `en`/`ko` samples, and would grow the slot after mount. Measuring
 * every locale the format can resolve to keeps the reservation an upper bound,
 * so there is no layout shift in the default "follow browser" mode.
 *
 * Compact never renders seconds or a timezone label (#556), so those two
 * preferences must not affect its reservation — otherwise enabling "show
 * timezone label" would widen compact slots whose output is unchanged. They are
 * folded out of both the cache key and the label margin in compact mode.
 *
 * A small margin is added; the timezone-label offset varies by zone (e.g.
 * `GMT+13:45` is wider than the `GMT+9` measured here), so extra headroom is
 * reserved when the label is shown (general only).
 */
export function reservedWidthCh(
  mode: "general" | "compact",
  resolved: ResolvedTimeFormat,
): number {
  // Fold out the compact-irrelevant knobs so they neither split the cache nor
  // inflate the margin: compact output ignores seconds and the tz label.
  const seconds = mode === "general" ? resolved.seconds : false;
  const tzLabel = mode === "general" ? resolved.tzLabel : false;
  const cacheKey = `${mode}|${resolved.locale ?? ""}|${resolved.hourCycle ?? ""}|${seconds}|${tzLabel}`;
  const cached = reservedWidthCache.get(cacheKey);
  if (cached !== undefined) return cached;
  // Explicit locale → measure only itself; "follow browser/app" → measure the
  // whole curated set to bound every locale the render could resolve to.
  const locales = resolved.locale ? [resolved.locale] : TIME_FORMAT_LOCALES;
  let max = 0;
  for (const locale of locales) {
    const sample =
      mode === "compact"
        ? formatDateTimeCompact(WORST_INSTANT, WORST_TZ, locale, {
            hourCycle: resolved.hourCycle,
          })
        : formatDateTime(WORST_INSTANT, WORST_TZ, { ...resolved, locale });
    const ch = footprintCh(sample);
    if (ch > max) max = ch;
  }
  const width = max + (tzLabel ? 4 : 1);
  reservedWidthCache.set(cacheKey, width);
  return width;
}
