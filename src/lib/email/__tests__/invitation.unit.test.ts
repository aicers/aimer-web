import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

// Mock transport to test sendInvitationEmail without real SMTP
const { mockSendMail } = vi.hoisted(() => ({
  mockSendMail: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../transport", () => ({
  sendMail: mockSendMail,
}));

import {
  buildInvitationHtml,
  buildInvitationLink,
  buildInvitationText,
  type InvitationEmailParams,
  sendInvitationEmail,
} from "../invitation";

const params: InvitationEmailParams = {
  to: "alice@example.com",
  token: "abc123token",
  customerName: "Acme Corp",
  roleName: "Manager",
  expiresAt: new Date("2026-04-01T12:00:00Z"),
  baseUrl: "https://aimer.example.com",
};

describe("buildInvitationLink", () => {
  it("constructs the correct acceptance URL", () => {
    expect(buildInvitationLink("https://aimer.example.com", "tok123")).toBe(
      "https://aimer.example.com/api/auth/invite/tok123",
    );
  });

  it("preserves base64url tokens with special characters", () => {
    const token = "AbCdEf-_01234567890abcdef";
    expect(buildInvitationLink("https://x.com", token)).toBe(
      `https://x.com/api/auth/invite/${token}`,
    );
  });
});

describe("buildInvitationText", () => {
  const text = buildInvitationText(params);

  it("includes the customer name", () => {
    expect(text).toContain("Acme Corp");
  });

  it("includes the role", () => {
    expect(text).toContain("Manager");
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

  it("works with User role", () => {
    const userText = buildInvitationText({ ...params, roleName: "User" });
    expect(userText).toContain("User");
    expect(userText).not.toContain("Manager");
  });
});

describe("buildInvitationHtml", () => {
  const html = buildInvitationHtml(params);

  it("includes the customer name", () => {
    expect(html).toContain("Acme Corp");
  });

  it("includes the role", () => {
    expect(html).toContain("Manager");
  });

  it("includes the invitation link as an anchor", () => {
    expect(html).toContain(
      'href="https://aimer.example.com/api/auth/invite/abc123token"',
    );
  });

  it("escapes HTML in customer name", () => {
    const xssParams = {
      ...params,
      customerName: '<script>alert("xss")</script>',
    };
    const result = buildInvitationHtml(xssParams);
    expect(result).not.toContain("<script>");
    expect(result).toContain("&lt;script&gt;");
  });

  it("escapes HTML in role name", () => {
    const xssParams = { ...params, roleName: '<img onerror="alert(1)">' };
    const result = buildInvitationHtml(xssParams);
    expect(result).not.toContain("<img");
    expect(result).toContain("&lt;img");
  });

  it("escapes single quotes in customer name", () => {
    const sqParams = { ...params, customerName: "O'Reilly Corp" };
    const result = buildInvitationHtml(sqParams);
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

describe("sendInvitationEmail", () => {
  afterEach(() => {
    mockSendMail.mockClear();
  });

  it("calls sendMail with correct subject, to, text, and html", async () => {
    await sendInvitationEmail(params);

    expect(mockSendMail).toHaveBeenCalledTimes(1);
    const call = mockSendMail.mock.calls[0][0];
    expect(call.to).toBe("alice@example.com");
    expect(call.subject).toContain("Acme Corp");
    expect(call.text).toContain("Acme Corp");
    expect(call.text).toContain("Manager");
    expect(call.text).toContain("/api/auth/invite/abc123token");
    expect(call.html).toContain("Acme Corp");
    expect(call.html).toContain("Manager");
    expect(call.html).toContain("/api/auth/invite/abc123token");
  });

  it("propagates transport errors", async () => {
    mockSendMail.mockRejectedValueOnce(new Error("SMTP error"));

    await expect(sendInvitationEmail(params)).rejects.toThrow("SMTP error");
  });
});
