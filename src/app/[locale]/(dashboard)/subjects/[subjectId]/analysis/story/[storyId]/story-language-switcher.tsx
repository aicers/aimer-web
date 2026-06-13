import Link from "next/link";
import type { AppLocale } from "@/i18n/locale";
import { mergeQuery } from "@/lib/navigation/query";

interface Props {
  /** Localized "Language" label. */
  label: string;
  /** Localized accessible name for the switcher navigation landmark. */
  navLabel: string;
  /**
   * The detail page path WITHOUT a query string
   * (`/{locale}/subjects/{sid}/analysis/story/{storyId}`). The switcher
   * rebuilds the query per option via {@link mergeQuery}.
   */
  basePath: string;
  /** The page's current query string — preserved across every option. */
  currentQuery: string;
  /** The language currently shown, as an app-locale code. */
  currentLocale: AppLocale;
  /**
   * One entry per supported language: its app-locale code, localized display
   * name, and whether a stored result already exists for it (an unavailable
   * option still links — selecting it requests that variant, which falls back
   * to English until the translation lands).
   */
  languages: ReadonlyArray<{
    locale: AppLocale;
    name: string;
    available: boolean;
  }>;
}

/**
 * #580 — per-story language switcher, mirroring the periodic-report switcher.
 * Encodes the chosen language in the URL as an app-locale code (`?lang=ko`) and
 * preserves the other variant params via the shared {@link mergeQuery} helper.
 * URL = locale code, DB/aimer = enum: this surface only ever speaks the
 * locale-code vocabulary.
 */
export function StoryLanguageSwitcher({
  label,
  navLabel,
  basePath,
  currentQuery,
  currentLocale,
  languages,
}: Props) {
  return (
    <nav
      aria-label={navLabel}
      data-testid="story-language-switcher"
      className="flex items-center gap-2 text-sm"
    >
      <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </span>
      <ul className="flex items-center gap-1">
        {languages.map(({ locale, name, available }) => {
          const active = locale === currentLocale;
          const className = `inline-flex items-center rounded border px-2 py-1 text-sm font-medium ${
            active
              ? "border-foreground text-foreground"
              : "border-border text-muted-foreground hover:text-foreground"
          }`;
          if (active) {
            return (
              <li key={locale}>
                <span
                  aria-current="true"
                  data-testid={`story-lang-${locale}`}
                  data-active={true}
                  data-available={available}
                  className={className}
                >
                  {name}
                </span>
              </li>
            );
          }
          const qs = mergeQuery(currentQuery, { lang: locale });
          return (
            <li key={locale}>
              <Link
                href={qs ? `${basePath}?${qs}` : basePath}
                data-testid={`story-lang-${locale}`}
                data-active={false}
                data-available={available}
                className={className}
              >
                {name}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
