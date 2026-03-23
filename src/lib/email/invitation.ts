import "server-only";

import { sendMail } from "./transport";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface InvitationEmailParams {
  to: string;
  token: string;
  customerName: string;
  roleName: string;
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

export function buildInvitationLink(baseUrl: string, token: string): string {
  return `${baseUrl}/api/auth/invite/${token}`;
}

// ---------------------------------------------------------------------------
// Email content
// ---------------------------------------------------------------------------

export function buildInvitationText(params: InvitationEmailParams): string {
  const link = buildInvitationLink(params.baseUrl, params.token);
  const expiry = formatDate(params.expiresAt);

  return [
    `You've been invited to join ${params.customerName} on AIMER.`,
    "",
    `Role: ${params.roleName}`,
    `Expires: ${expiry}`,
    "",
    "Accept your invitation by visiting the link below:",
    link,
    "",
    "If you did not expect this invitation, you can safely ignore this email.",
  ].join("\n");
}

export function buildInvitationHtml(params: InvitationEmailParams): string {
  const link = buildInvitationLink(params.baseUrl, params.token);
  const expiry = formatDate(params.expiresAt);

  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"></head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; color: #1a1a1a; max-width: 560px; margin: 0 auto; padding: 24px;">
  <h2 style="margin-bottom: 16px;">You're invited to ${escapeHtml(params.customerName)}</h2>
  <p>You've been invited to join <strong>${escapeHtml(params.customerName)}</strong> on AIMER as a <strong>${escapeHtml(params.roleName)}</strong>.</p>
  <p style="margin: 24px 0;">
    <a href="${escapeHtml(link)}" style="display: inline-block; padding: 12px 24px; background: #111; color: #fff; text-decoration: none; border-radius: 6px;">Accept Invitation</a>
  </p>
  <p style="font-size: 14px; color: #666;">This invitation expires on ${escapeHtml(expiry)}.</p>
  <hr style="border: none; border-top: 1px solid #eee; margin: 24px 0;">
  <p style="font-size: 12px; color: #999;">If you did not expect this invitation, you can safely ignore this email.</p>
</body>
</html>`;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ---------------------------------------------------------------------------
// Send
// ---------------------------------------------------------------------------

export async function sendInvitationEmail(
  params: InvitationEmailParams,
): Promise<void> {
  const subject = `Invitation to join ${params.customerName} on AIMER`;

  await sendMail({
    to: params.to,
    subject,
    text: buildInvitationText(params),
    html: buildInvitationHtml(params),
  });
}
