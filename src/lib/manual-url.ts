const DEFAULT_BASE = "https://aicers.github.io/aimer-web";

function getBase(): string {
  const fromEnv = process.env.NEXT_PUBLIC_MANUAL_BASE_URL;
  return fromEnv && fromEnv.length > 0 ? fromEnv : DEFAULT_BASE;
}

export function manualUrl(slug: string, locale: "en" | "ko" = "en"): string {
  const base = getBase().replace(/\/+$/, "");
  const path = locale === "ko" ? `/ko/${slug}/` : `/${slug}/`;
  return `${base}${path}`;
}
