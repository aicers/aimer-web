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
import {
  isTimeFormatLocale,
  type TimeFormatHourCycle,
} from "@/lib/datetime/format-timestamp";
import { getAuthPool, query } from "@/lib/db/client";

/**
 * Self-service account preferences (#387). Writes `accounts.locale` /
 * `accounts.timezone` and the date/time display-format preference
 * (`accounts.time_format_*`, #556) for the *current* session — distinct from
 * the admin-only `/api/admin/accounts/[accountId]` route.
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
  const hasTfLocale = "timeFormatLocale" in body;
  const hasTfHourCycle = "timeFormatHourCycle" in body;
  const hasTfSeconds = "timeFormatSeconds" in body;
  const hasTfTzLabel = "timeFormatTzLabel" in body;
  if (
    !hasLocale &&
    !hasTimezone &&
    !hasTfLocale &&
    !hasTfHourCycle &&
    !hasTfSeconds &&
    !hasTfTzLabel
  ) {
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

  // Display-format preference (#556). Each field is independently nullable;
  // `null` resets to the app default. Validation rejects out-of-list locale
  // values and unknown hour-cycle values rather than silently storing them.
  let nextTfLocale: string | null = null;
  if (hasTfLocale) {
    const value = body.timeFormatLocale;
    if (value === null) {
      nextTfLocale = null;
    } else if (isTimeFormatLocale(value)) {
      nextTfLocale = value as string;
    } else {
      return Response.json(
        { error: "timeFormatLocale must be 'app' or a supported BCP-47 tag" },
        { status: 400 },
      );
    }
  }

  let nextTfHourCycle: TimeFormatHourCycle | null = null;
  if (hasTfHourCycle) {
    const value = body.timeFormatHourCycle;
    if (value === null) {
      nextTfHourCycle = null;
    } else if (value === "h12" || value === "h23") {
      nextTfHourCycle = value;
    } else {
      return Response.json(
        { error: "timeFormatHourCycle must be 'h12' or 'h23'" },
        { status: 400 },
      );
    }
  }

  let nextTfSeconds: boolean | null = null;
  if (hasTfSeconds) {
    const value = body.timeFormatSeconds;
    if (value === null || typeof value === "boolean") {
      nextTfSeconds = value;
    } else {
      return Response.json(
        { error: "timeFormatSeconds must be a boolean or null" },
        { status: 400 },
      );
    }
  }

  let nextTfTzLabel: boolean | null = null;
  if (hasTfTzLabel) {
    const value = body.timeFormatTzLabel;
    if (value === null || typeof value === "boolean") {
      nextTfTzLabel = value;
    } else {
      return Response.json(
        { error: "timeFormatTzLabel must be a boolean or null" },
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
  if (hasTfLocale) {
    sets.push(`time_format_locale = $${i++}`);
    params.push(nextTfLocale);
  }
  if (hasTfHourCycle) {
    sets.push(`time_format_hour_cycle = $${i++}`);
    params.push(nextTfHourCycle);
  }
  if (hasTfSeconds) {
    sets.push(`time_format_seconds = $${i++}`);
    params.push(nextTfSeconds);
  }
  if (hasTfTzLabel) {
    sets.push(`time_format_tz_label = $${i++}`);
    params.push(nextTfTzLabel);
  }
  params.push(auth.accountId);

  const rows = await query<{
    locale: string | null;
    timezone: string | null;
    time_format_locale: string | null;
    time_format_hour_cycle: TimeFormatHourCycle | null;
    time_format_seconds: boolean | null;
    time_format_tz_label: boolean | null;
  }>(
    getAuthPool(),
    `UPDATE accounts SET ${sets.join(", ")}, updated_at = NOW()
     WHERE id = $${i}
     RETURNING locale, timezone, time_format_locale, time_format_hour_cycle,
               time_format_seconds, time_format_tz_label`,
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
    ...(hasTfLocale ? { timeFormatLocale: nextTfLocale } : {}),
    ...(hasTfHourCycle ? { timeFormatHourCycle: nextTfHourCycle } : {}),
    ...(hasTfSeconds ? { timeFormatSeconds: nextTfSeconds } : {}),
    ...(hasTfTzLabel ? { timeFormatTzLabel: nextTfTzLabel } : {}),
  };

  return Response.json({
    locale: rows[0].locale,
    timezone: rows[0].timezone,
    timeFormatLocale: rows[0].time_format_locale,
    timeFormatHourCycle: rows[0].time_format_hour_cycle,
    timeFormatSeconds: rows[0].time_format_seconds,
    timeFormatTzLabel: rows[0].time_format_tz_label,
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
 * Cookie *presence* is not proof of a live session: auth cookies live until
 * absolute expiry, but `withAuth` can still reject a session earlier (idle
 * timeout / revocation), and admin activity does not refresh the general
 * session. So we cannot pick the context from cookie presence alone — an
 * admin working after the general session idled out would be forced down the
 * general handler and 401, and the shared admin-header switcher would fall
 * back to a cookie-only update without persisting `accounts.locale`.
 *
 * Instead we try the general context first and fall through to admin on a
 * 401. `withAuth` returns 401 *before* the handler runs — and before the body
 * is read — so the same request can be safely re-dispatched to the admin
 * handler. Any non-401 response (success, 400 validation, 403 CSRF/origin)
 * means the general session was live and owns the request, so we return it
 * unchanged. The client sends both CSRF headers when available, so whichever
 * context ends up handling the request has its token.
 */
export async function PATCH(req: NextRequest): Promise<Response> {
  const hasGeneral = (await getAuthCookie("general")) !== null;
  const hasAdmin = (await getAuthCookie("admin")) !== null;

  if (hasGeneral) {
    const res = await patchGeneral(req);
    if (res.status === 401 && hasAdmin) {
      return patchAdmin(req);
    }
    return res;
  }
  return patchAdmin(req);
}
