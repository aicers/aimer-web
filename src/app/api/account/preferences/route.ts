import type { NextRequest } from "next/server";
import {
  type AppLocale,
  isSupportedLocale,
  isValidTimeZone,
} from "@/i18n/locale";
import {
  clearNextLocaleCookie,
  setNextLocaleCookie,
} from "@/i18n/locale-cookie";
import { getAuthCookie } from "@/lib/auth/cookies";
import {
  type AuthenticatedRequest,
  verifyCsrf,
  verifyOrigin,
  withAuth,
} from "@/lib/auth/guards";
import { getAuthPool, query } from "@/lib/db/client";

/**
 * Self-service account preferences (#387). Writes `accounts.locale` /
 * `accounts.timezone` for the *current* session — distinct from the
 * admin-only `/api/admin/accounts/[accountId]` route.
 *
 * The preference is a single account-level value shared by the regular
 * and admin sessions of the same account (both `me` endpoints expose it;
 * both sign-in callbacks sync it to the cookie). The settings UI lives in
 * the general dashboard, but the header language switcher is rendered in
 * both the general and admin headers, so this route authorizes *either*
 * session (see `PATCH` below) — otherwise an admin-only session toggling
 * the switcher would 401 and never persist its choice to `accounts.locale`.
 */
async function handlePreferences(
  req: NextRequest,
  auth: AuthenticatedRequest,
): Promise<Response> {
  const originErr = verifyOrigin(req);
  if (originErr) return originErr;

  const csrfErr = verifyCsrf(req, {
    ctx: auth.authContext,
    sid: auth.sessionId,
    iat: auth.iat,
  });
  if (csrfErr) return csrfErr;

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return Response.json(
      { error: "Request body must be a JSON object" },
      { status: 400 },
    );
  }

  const body = raw as Record<string, unknown>;
  const hasLocale = "locale" in body;
  const hasTimezone = "timezone" in body;
  if (!hasLocale && !hasTimezone) {
    return Response.json(
      { error: "No updatable fields provided" },
      { status: 400 },
    );
  }

  let nextLocale: AppLocale | null = null;
  if (hasLocale) {
    const value = body.locale;
    if (value === null) {
      nextLocale = null;
    } else if (isSupportedLocale(value)) {
      nextLocale = value;
    } else {
      return Response.json(
        { error: "locale must be 'en' or 'ko'" },
        { status: 400 },
      );
    }
  }

  let nextTimezone: string | null = null;
  if (hasTimezone) {
    const value = body.timezone;
    if (value === null) {
      nextTimezone = null;
    } else if (isValidTimeZone(value)) {
      nextTimezone = value;
    } else {
      return Response.json(
        { error: "timezone must be a valid IANA time zone" },
        { status: 400 },
      );
    }
  }

  const sets: string[] = [];
  const params: unknown[] = [];
  let i = 1;
  if (hasLocale) {
    sets.push(`locale = $${i++}`);
    params.push(nextLocale);
  }
  if (hasTimezone) {
    sets.push(`timezone = $${i++}`);
    params.push(nextTimezone);
  }
  params.push(auth.accountId);

  const rows = await query<{
    locale: string | null;
    timezone: string | null;
  }>(
    getAuthPool(),
    `UPDATE accounts SET ${sets.join(", ")}, updated_at = NOW()
     WHERE id = $${i}
     RETURNING locale, timezone`,
    params,
  );
  if (rows.length === 0) {
    return Response.json({ error: "Account not found" }, { status: 404 });
  }

  // Mirror the saved locale into the NEXT_LOCALE cookie so resolution
  // stays in the next-intl middleware (cookie ↔ DB stay in sync).
  if (hasLocale) {
    if (nextLocale) {
      await setNextLocaleCookie(nextLocale);
    } else {
      await clearNextLocaleCookie();
    }
  }

  auth.audit.targetId = auth.accountId;
  auth.audit.details = {
    ...(hasLocale ? { locale: nextLocale } : {}),
    ...(hasTimezone ? { timezone: nextTimezone } : {}),
  };

  return Response.json({
    locale: rows[0].locale,
    timezone: rows[0].timezone,
  });
}

const auditOption = {
  action: "account.preferences_updated",
  targetType: "account",
} as const;

const patchGeneral = withAuth(handlePreferences, {
  ctx: "general",
  audit: auditOption,
});
const patchAdmin = withAuth(handlePreferences, {
  ctx: "admin",
  audit: auditOption,
});

/**
 * Authorize either the general or the admin session of the account.
 *
 * The body can only be read once, so the context is chosen up front by
 * cookie presence (general preferred when both are present — it is the
 * same account-level value either way). The client sends both CSRF
 * headers when available, so whichever context is chosen has its token.
 */
export async function PATCH(req: NextRequest): Promise<Response> {
  const hasGeneral = (await getAuthCookie("general")) !== null;
  return hasGeneral ? patchGeneral(req) : patchAdmin(req);
}
