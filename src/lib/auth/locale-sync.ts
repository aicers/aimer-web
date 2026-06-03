import type { Pool, PoolClient } from "pg";
import { type AppLocale, isSupportedLocale } from "@/i18n/locale";

/**
 * Reconcile the saved `accounts.locale` with a pre-existing `NEXT_LOCALE`
 * cookie at sign-in (L1 / #387).
 *
 * Returns the app locale to mirror into the `NEXT_LOCALE` cookie, or
 * `null` when there is no saved preference — in which case the caller
 * leaves the cookie alone and next-intl negotiates `Accept-Language`.
 *
 * Resolution rules (documented + tested per #387):
 *
 *  1. A valid saved `accounts.locale` always wins and is mirrored to the
 *     cookie, so locale resolution stays in the next-intl middleware with
 *     no per-request DB lookup.
 *  2. When the DB locale is `NULL` but a valid `NEXT_LOCALE` cookie exists,
 *     the cookie value is *promoted* to `accounts.locale` — the user is
 *     then treated as having a saved preference. This is the chosen rule
 *     for the "no saved preference + leftover cookie" case: without it the
 *     next-intl middleware would silently prefer the cookie over
 *     `Accept-Language`, contradicting the resolution order.
 *  3. Otherwise (no saved preference, no valid cookie) returns `null` so
 *     `Accept-Language` negotiation applies.
 */
export async function reconcileSignInLocale(
  client: Pool | PoolClient,
  accountId: string,
  dbLocale: string | null,
  cookieLocale: string | undefined,
): Promise<AppLocale | null> {
  if (isSupportedLocale(dbLocale)) {
    return dbLocale;
  }
  if (isSupportedLocale(cookieLocale)) {
    await client.query(
      `UPDATE accounts SET locale = $1, updated_at = NOW() WHERE id = $2`,
      [cookieLocale, accountId],
    );
    return cookieLocale;
  }
  return null;
}
