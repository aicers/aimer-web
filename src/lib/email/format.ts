import "server-only";

// ---------------------------------------------------------------------------
// Email formatting policy
//
// Outgoing invitation emails are rendered server-side for a recipient who is
// not yet an account (an invitee), so neither the recipient's locale nor
// timezone is known. The email body is English-only (hard-coded copy,
// `<html lang="en">`); no Korean (or other non-English) email surface exists.
// Given that, date formatting follows a single, deliberate policy:
//
//   - Timezone: pinned to UTC and labelled explicitly (`timeZoneName: "short"`)
//     so the output is unambiguous and independent of the server process's
//     `TZ` (e.g. `April 1, 2026 at 12:00 PM UTC`).
//   - Locale: fixed English (`en-US`) by deliberate policy — chosen because
//     the entire email body is English, not as an incidental copy-paste.
//   - API: `Intl.DateTimeFormat` (time-capable), not `toLocaleDateString`,
//     since the rendered value is a full timestamp, not a date alone.
//
// This is intentionally kept separate from the in-app `<Timestamp>` /
// `format-timestamp` stack, which hydrates client-side and resolves the
// signed-in account's timezone — neither of which applies to an email sent to
// a not-yet-account recipient.
//
// Carrying the inviter's account locale/timezone into the email is a viable
// future personalization but is deliberately deferred; the UTC default stands
// until that plumbing exists.
// ---------------------------------------------------------------------------

/** Deliberate English-only locale for outgoing email copy (see policy above). */
const EMAIL_LOCALE = "en-US";

const expiryFormatter = new Intl.DateTimeFormat(EMAIL_LOCALE, {
  year: "numeric",
  month: "long",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  timeZone: "UTC",
  timeZoneName: "short",
});

/**
 * Formats a timestamp for display in an outgoing email body, pinned to UTC and
 * labelled, per the email formatting policy above. Despite the email surface
 * being English-only, the value is a full timestamp (date + time + zone), so
 * this is deliberately not a date-only formatter.
 */
export function formatEmailTimestamp(date: Date): string {
  return expiryFormatter.format(date);
}

/** Escapes HTML special characters for safe interpolation into email markup. */
export function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
