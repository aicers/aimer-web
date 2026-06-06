import "server-only";

import { buildInvitationLink } from "./invitation";
import { sendMail } from "./transport";

// ---------------------------------------------------------------------------
// Types
//
// Analyst invitations differ from member invitations: there is no single
// `customerName` / `roleName`, but a set of customers the analyst is being
// granted access to. The member email builder (`sendInvitationEmail`) is
// therefore unfit; this is an analyst-specific builder. Only the link helper
// (`buildInvitationLink` → /api/auth/invite/${token}) is shared, since #268
// resolves the same entry endpoint for both invitation types.
// ---------------------------------------------------------------------------

export interface AnalystInvitationEmailParams {
  to: string;
  token: string;
  /** Names of the customers the analyst is being assigned to. */
  customerNames: string[];
  expiresAt: Date;
  baseUrl: string;
}

// ---------------------------------------------------------------------------
// Template helpers
// ---------------------------------------------------------------------------

function formatDate(date: Date): string {
  return date.toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZoneName: "short",
  });
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatCustomerList(names: string[]): string {
  return names.length > 0 ? names.join(", ") : "your assigned organizations";
}

// ---------------------------------------------------------------------------
// Email content
// ---------------------------------------------------------------------------

export function buildAnalystInvitationText(
  params: AnalystInvitationEmailParams,
): string {
  const link = buildInvitationLink(params.baseUrl, params.token);
  const expiry = formatDate(params.expiresAt);
  const customers = formatCustomerList(params.customerNames);

  return [
    "You've been invited to join Clumit Insight as an analyst.",
    "",
    `Organizations: ${customers}`,
    `Expires: ${expiry}`,
    "",
    "Accept your invitation by visiting the link below:",
    link,
    "",
    "If you did not expect this invitation, you can safely ignore this email.",
  ].join("\n");
}

export function buildAnalystInvitationHtml(
  params: AnalystInvitationEmailParams,
): string {
  const link = buildInvitationLink(params.baseUrl, params.token);
  const expiry = formatDate(params.expiresAt);
  const customers = formatCustomerList(params.customerNames);

  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"></head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; color: #1a1a1a; max-width: 560px; margin: 0 auto; padding: 24px;">
  <h2 style="margin-bottom: 16px;">You're invited as an analyst</h2>
  <p>You've been invited to join <strong>Clumit Insight</strong> as an analyst for the following organizations:</p>
  <p style="margin: 8px 0;"><strong>${escapeHtml(customers)}</strong></p>
  <p style="margin: 24px 0;">
    <a href="${escapeHtml(link)}" style="display: inline-block; padding: 12px 24px; background: #111; color: #fff; text-decoration: none; border-radius: 6px;">Accept Invitation</a>
  </p>
  <p style="font-size: 14px; color: #666;">This invitation expires on ${escapeHtml(expiry)}.</p>
  <hr style="border: none; border-top: 1px solid #eee; margin: 24px 0;">
  <p style="font-size: 12px; color: #999;">If you did not expect this invitation, you can safely ignore this email.</p>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Send
// ---------------------------------------------------------------------------

export async function sendAnalystInvitationEmail(
  params: AnalystInvitationEmailParams,
): Promise<void> {
  await sendMail({
    to: params.to,
    subject: "Invitation to join Clumit Insight as an analyst",
    text: buildAnalystInvitationText(params),
    html: buildAnalystInvitationHtml(params),
  });
}
