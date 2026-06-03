import { cookies } from "next/headers";
import type { AppLocale } from "./locale";

/**
 * Cookie next-intl reads to resolve the active locale when no `[locale]`
 * URL prefix is present. We mirror the saved `accounts.locale` into it at
 * sign-in and on settings change so locale resolution stays inside the
 * existing next-intl middleware (no per-request DB lookup in `proxy.ts`).
 */
export const NEXT_LOCALE_COOKIE = "NEXT_LOCALE";

// One year, matching the client-side write in `locale-switcher.tsx`.
const NEXT_LOCALE_MAX_AGE = 31_536_000;

/** Write-through the resolved locale to the `NEXT_LOCALE` cookie. */
export async function setNextLocaleCookie(locale: AppLocale): Promise<void> {
  const jar = await cookies();
  jar.set(NEXT_LOCALE_COOKIE, locale, {
    path: "/",
    maxAge: NEXT_LOCALE_MAX_AGE,
    sameSite: "lax",
  });
}

/**
 * Clear the `NEXT_LOCALE` cookie so next-intl falls through to
 * `Accept-Language`. Used when a user clears their saved preference.
 */
export async function clearNextLocaleCookie(): Promise<void> {
  const jar = await cookies();
  jar.delete(NEXT_LOCALE_COOKIE);
}
