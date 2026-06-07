// Mailpit HTTP API helper for Tier-2 E2E (#452).
//
// The analyst invitation email is sent from a deferred Next.js `after()`
// callback (src/app/api/admin/analysts/invitations/route.ts), so it lags the
// 201 response. Specs must POLL Mailpit for the message rather than read once.
//
// Mailpit API reference: https://mailpit.axllent.org/docs/api-v1/

const API_BASE = process.env.MAILPIT_API_URL ?? "http://localhost:8025";

interface MailpitMessageSummary {
  ID: string;
  To: Array<{ Address: string; Name: string }>;
  Subject: string;
  Created: string;
}

interface MailpitMessagesResponse {
  messages: MailpitMessageSummary[];
}

interface MailpitMessage {
  ID: string;
  Text: string;
  HTML: string;
}

function recipientMatches(msg: MailpitMessageSummary, email: string): boolean {
  const target = email.toLowerCase();
  return msg.To.some((t) => t.Address.toLowerCase() === target);
}

/**
 * Poll Mailpit for the most recent message addressed to `email`.
 * Messages are returned newest-first by the API. Throws on timeout.
 */
export async function waitForLatestMessageTo(
  email: string,
  opts: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<MailpitMessageSummary> {
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const intervalMs = opts.intervalMs ?? 500;
  const deadline = Date.now() + timeoutMs;

  let lastError = "no matching message";
  while (Date.now() < deadline) {
    const res = await fetch(`${API_BASE}/api/v1/messages?limit=50`);
    if (res.ok) {
      const body = (await res.json()) as MailpitMessagesResponse;
      const match = body.messages.find((m) => recipientMatches(m, email));
      if (match) return match;
      lastError = `no message to ${email} among ${body.messages.length}`;
    } else {
      lastError = `Mailpit list failed: ${res.status}`;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`waitForLatestMessageTo(${email}) timed out: ${lastError}`);
}

/**
 * Fetch a message by id and extract the first `/api/auth/invite/:token` URL
 * from its body (HTML preferred, text as fallback).
 */
export async function extractInviteLink(messageId: string): Promise<string> {
  const res = await fetch(`${API_BASE}/api/v1/message/${messageId}`);
  if (!res.ok) {
    throw new Error(`Mailpit fetch message ${messageId} failed: ${res.status}`);
  }
  const msg = (await res.json()) as MailpitMessage;
  const body = `${msg.HTML ?? ""}\n${msg.Text ?? ""}`;
  // Match an absolute or relative invite-entry URL.
  const match = body.match(
    /https?:\/\/[^\s"'<>]+\/api\/auth\/invite\/[^\s"'<>]+/,
  );
  if (!match) {
    throw new Error(
      `No /api/auth/invite/:token link found in message ${messageId}`,
    );
  }
  return match[0];
}

/** Delete all captured messages — call before a flow for test isolation. */
export async function deleteAllMessages(): Promise<void> {
  const res = await fetch(`${API_BASE}/api/v1/messages`, { method: "DELETE" });
  if (!res.ok) {
    throw new Error(`Mailpit delete-all failed: ${res.status}`);
  }
}
