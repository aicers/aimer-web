import Link from "next/link";
import type { AppLocale } from "@/i18n/locale";
import { mergeQuery } from "@/lib/navigation/query";

interface Props {
  /** Localized "Language" label. */
  label: string;
  /**
   * The detail page path WITHOUT a query string
   * (`/{locale}/customers/{cid}/analysis/reports/{period}/{bucket}`). The
   * switcher rebuilds the query per option via {@link mergeQuery}.
   */
  basePath: string;
  /** The page's current query string — preserved across every option. */
  currentQuery: string;
  /** The language currently shown, as an app-locale code. */
  currentLocale: AppLocale;
  /**
   * One entry per supported language: its app-locale code, localized display
   * name, and whether a stored result already exists for it (an unavailable
   * option still links — selecting it requests on-demand generation).
   */
  languages: ReadonlyArray<{
    locale: AppLocale;
    name: string;
    available: boolean;
  }>;
}

/**
 * #388 (L2) — per-report language switcher. Encodes the chosen language in the
 * URL as an app-locale code (`?lang=ko`) and preserves the other variant
 * params (`tz`/`model_name`/`model`) via the shared {@link mergeQuery} helper,
 * so tabs and switcher carry the query identically. URL = locale code,
 * DB/API = enum: this surface only ever speaks the locale-code vocabulary.
 */
export function ReportLanguageSwitcher({
  label,
  basePath,
  currentQuery,
  currentLocale,
  languages,
}: Props) {
  return (
    <nav
      aria-label="report-language-switcher"
      data-testid="report-language-switcher"
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
                  data-testid={`report-lang-${locale}`}
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
                data-testid={`report-lang-${locale}`}
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
