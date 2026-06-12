import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

// Mock transport to test sendAnalystInvitationEmail without real SMTP
const { mockSendMail } = vi.hoisted(() => ({
  mockSendMail: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../transport", () => ({
  sendMail: mockSendMail,
}));

import {
  type AnalystInvitationEmailParams,
  buildAnalystInvitationHtml,
  buildAnalystInvitationText,
  sendAnalystInvitationEmail,
} from "../analyst-invitation";

const params: AnalystInvitationEmailParams = {
  to: "analyst@example.com",
  token: "abc123token",
  customerNames: ["Acme Corp", "Globex"],
  expiresAt: new Date("2026-04-01T12:00:00Z"),
  baseUrl: "https://aimer.example.com",
};

describe("buildAnalystInvitationText", () => {
  const text = buildAnalystInvitationText(params);

  it("describes an analyst invitation", () => {
    expect(text).toContain("as an analyst");
  });

  it("lists the assigned organizations", () => {
    expect(text).toContain("Acme Corp, Globex");
  });

  it("falls back when no organizations are provided", () => {
    const emptyText = buildAnalystInvitationText({
      ...params,
      customerNames: [],
    });
    expect(emptyText).toContain("your assigned organizations");
  });

  it("includes the invitation link", () => {
    expect(text).toContain(
      "https://aimer.example.com/api/auth/invite/abc123token",
    );
  });

  it("renders the expiry as a UTC-pinned, English timestamp", () => {
    // expiresAt is 2026-04-01T12:00:00Z; the email policy pins display to UTC
    // and labels the zone, regardless of the server's TZ.
    expect(text).toContain("Expires: April 1, 2026 at 12:00 PM UTC");
  });

  it("includes a safe-ignore notice", () => {
    expect(text).toContain("safely ignore");
  });
});

describe("buildAnalystInvitationHtml", () => {
  const html = buildAnalystInvitationHtml(params);

  it("lists the assigned organizations", () => {
    expect(html).toContain("Acme Corp, Globex");
  });

  it("includes the invitation link as an anchor", () => {
    expect(html).toContain(
      'href="https://aimer.example.com/api/auth/invite/abc123token"',
    );
  });

  it("escapes HTML in customer names", () => {
    const xssParams = {
      ...params,
      customerNames: ['<script>alert("xss")</script>'],
    };
    const result = buildAnalystInvitationHtml(xssParams);
    expect(result).not.toContain("<script>");
    expect(result).toContain("&lt;script&gt;");
  });

  it("escapes single quotes in customer names", () => {
    const sqParams = { ...params, customerNames: ["O'Reilly Corp"] };
    const result = buildAnalystInvitationHtml(sqParams);
    expect(result).not.toContain("O'Reilly");
    expect(result).toContain("O&#39;Reilly");
  });

  it("renders the expiry as a UTC-pinned, English timestamp", () => {
    expect(html).toContain(
      "This invitation expires on April 1, 2026 at 12:00 PM UTC.",
    );
  });

  it("is valid HTML with doctype", () => {
    expect(html).toMatch(/^<!DOCTYPE html>/);
  });

  it("includes a safe-ignore notice", () => {
    expect(html).toContain("safely ignore");
  });
});

describe("sendAnalystInvitationEmail", () => {
  afterEach(() => {
    mockSendMail.mockClear();
  });

  it("calls sendMail with correct subject, to, text, and html", async () => {
    await sendAnalystInvitationEmail(params);

    expect(mockSendMail).toHaveBeenCalledTimes(1);
    const call = mockSendMail.mock.calls[0][0];
    expect(call.to).toBe("analyst@example.com");
    expect(call.subject).toContain("analyst");
    expect(call.text).toContain("Acme Corp, Globex");
    expect(call.text).toContain("/api/auth/invite/abc123token");
    expect(call.html).toContain("Acme Corp, Globex");
    expect(call.html).toContain("/api/auth/invite/abc123token");
  });

  it("propagates transport errors", async () => {
    mockSendMail.mockRejectedValueOnce(new Error("SMTP error"));

    await expect(sendAnalystInvitationEmail(params)).rejects.toThrow(
      "SMTP error",
    );
  });
});
