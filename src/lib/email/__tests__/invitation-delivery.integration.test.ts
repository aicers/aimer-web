/**
 * Integration test: sends a real invitation email to Mailpit (local SMTP
 * capture) and verifies delivery + content via Mailpit's REST API.
 *
 * Requires Mailpit running at localhost:1025 (SMTP) / localhost:8025 (API).
 * Skipped automatically when Mailpit is not reachable.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mock server-only so we can import the real invitation module
// ---------------------------------------------------------------------------

vi.mock("server-only", () => ({}));

// ---------------------------------------------------------------------------
// Mailpit helpers
// ---------------------------------------------------------------------------

const MAILPIT_API = "http://localhost:8025/api/v1";

async function isMailpitAvailable(): Promise<boolean> {
  try {
    const res = await fetch(`${MAILPIT_API}/info`, {
      signal: AbortSignal.timeout(2000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function clearMailpit(): Promise<void> {
  await fetch(`${MAILPIT_API}/messages`, { method: "DELETE" });
}

interface MailpitMessage {
  ID: string;
  From: { Address: string };
  To: Array<{ Address: string }>;
  Subject: string;
  Snippet: string;
}

interface MailpitList {
  messages: MailpitMessage[];
  messages_count: number;
}

async function waitForMessages(
  expected: number,
  timeoutMs = 5000,
): Promise<MailpitList> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const res = await fetch(`${MAILPIT_API}/messages`);
    const data = (await res.json()) as MailpitList;
    if (data.messages_count >= expected) return data;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(
    `Timed out waiting for ${expected} message(s) in Mailpit after ${timeoutMs}ms`,
  );
}

interface MailpitMessageDetail {
  ID: string;
  Text: string;
  HTML: string;
}

async function getMessage(id: string): Promise<MailpitMessageDetail> {
  const res = await fetch(`${MAILPIT_API}/message/${id}`);
  return res.json() as Promise<MailpitMessageDetail>;
}

// ---------------------------------------------------------------------------
// Send using real template builders + direct nodemailer transport
// ---------------------------------------------------------------------------

import {
  buildInvitationHtml,
  buildInvitationLink,
  buildInvitationText,
  type InvitationEmailParams,
} from "../invitation";

const EMAIL_FROM = "noreply@aimer-test.com";

const testParams: InvitationEmailParams = {
  to: "invited@example.com",
  token: "test-token-abc123",
  customerName: "Integration Test Corp",
  roleName: "Manager",
  expiresAt: new Date("2026-12-31T23:59:59Z"),
  baseUrl: "https://aimer.example.com",
};

async function sendTestEmail(params: InvitationEmailParams) {
  const { createTransport } = await import("nodemailer");

  const transport = createTransport({
    host: "localhost",
    port: 1025,
    secure: false,
  });

  const subject = `Invitation to join ${params.customerName} on Clumit Insight`;

  await transport.sendMail({
    from: EMAIL_FROM,
    to: params.to,
    subject,
    text: buildInvitationText(params),
    html: buildInvitationHtml(params),
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const available = await isMailpitAvailable();

describe.skipIf(!available)(
  "invitation email delivery (Mailpit integration)",
  () => {
    // Each test sends its own email so tests are independently runnable.
    let sentMessage: MailpitMessage;
    let sentDetail: MailpitMessageDetail;

    beforeEach(async () => {
      await clearMailpit();
      await sendTestEmail(testParams);
      const { messages } = await waitForMessages(1);
      sentMessage = messages[0];
      sentDetail = await getMessage(sentMessage.ID);
    });

    afterAll(async () => {
      await clearMailpit();
    });

    it("delivers invitation email with correct recipient and subject", () => {
      expect(sentMessage.To[0].Address).toBe(testParams.to);
      expect(sentMessage.Subject).toContain(testParams.customerName);
      expect(sentMessage.From.Address).toBe(EMAIL_FROM);
    });

    it("email HTML body contains invitation link, org name, and role", () => {
      const expectedLink = buildInvitationLink(
        testParams.baseUrl,
        testParams.token,
      );

      expect(sentDetail.HTML).toContain("Integration Test Corp");
      expect(sentDetail.HTML).toContain("Manager");
      expect(sentDetail.HTML).toContain(expectedLink);
    });

    it("email plain text body contains invitation link, org name, and role", () => {
      const expectedLink = buildInvitationLink(
        testParams.baseUrl,
        testParams.token,
      );

      expect(sentDetail.Text).toContain("Integration Test Corp");
      expect(sentDetail.Text).toContain("Manager");
      expect(sentDetail.Text).toContain(expectedLink);
      expect(sentDetail.Text).toContain("safely ignore");
    });
  },
);
