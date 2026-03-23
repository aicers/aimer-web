import { afterEach, describe, expect, it, vi } from "vitest";

// Mock server-only (no-op in test environment)
vi.mock("server-only", () => ({}));

// Mock nodemailer before importing the module under test
const mockSendMail = vi.fn().mockResolvedValue({ messageId: "test-id" });
const mockCreateTransport = vi.fn(() => ({ sendMail: mockSendMail }));
vi.mock("nodemailer", () => ({
  createTransport: mockCreateTransport,
}));

// Import after mocks are set up
const { sendMail, _resetTransport } = await import("../transport");

function stubSmtp(overrides: Record<string, string> = {}) {
  const defaults: Record<string, string> = {
    SMTP_HOST: "mail.example.com",
    SMTP_PORT: "587",
    SMTP_USER: "user",
    SMTP_PASS: "pass",
    EMAIL_FROM: "noreply@example.com",
  };
  for (const [k, v] of Object.entries({ ...defaults, ...overrides })) {
    vi.stubEnv(k, v);
  }
}

afterEach(() => {
  _resetTransport();
  vi.unstubAllEnvs();
  mockSendMail.mockClear();
  mockCreateTransport.mockClear();
});

const mailOpts = {
  to: "bob@example.com",
  subject: "Test",
  text: "Hello",
  html: "<p>Hello</p>",
};

describe("sendMail", () => {
  it("does nothing when SMTP_HOST is missing", async () => {
    vi.stubEnv("SMTP_HOST", "");
    vi.stubEnv("SMTP_PORT", "587");
    vi.stubEnv("EMAIL_FROM", "x@example.com");

    await sendMail(mailOpts);
    expect(mockSendMail).not.toHaveBeenCalled();
    expect(mockCreateTransport).not.toHaveBeenCalled();
  });

  it("does nothing when SMTP_PORT is missing", async () => {
    vi.stubEnv("SMTP_HOST", "mail.example.com");
    vi.stubEnv("SMTP_PORT", "");
    vi.stubEnv("EMAIL_FROM", "x@example.com");

    await sendMail(mailOpts);
    expect(mockSendMail).not.toHaveBeenCalled();
  });

  it("does nothing when EMAIL_FROM is missing", async () => {
    vi.stubEnv("SMTP_HOST", "mail.example.com");
    vi.stubEnv("SMTP_PORT", "587");
    vi.stubEnv("EMAIL_FROM", "");

    await sendMail(mailOpts);
    expect(mockSendMail).not.toHaveBeenCalled();
  });

  it("sends email when fully configured", async () => {
    stubSmtp();

    await sendMail(mailOpts);

    expect(mockSendMail).toHaveBeenCalledWith({
      from: "noreply@example.com",
      to: "bob@example.com",
      subject: "Test",
      text: "Hello",
      html: "<p>Hello</p>",
    });
  });

  it("skips auth when SMTP_USER is empty", async () => {
    stubSmtp({ SMTP_USER: "", SMTP_PASS: "" });

    await sendMail(mailOpts);

    expect(mockCreateTransport).toHaveBeenCalledWith(
      expect.objectContaining({ auth: undefined }),
    );
    expect(mockSendMail).toHaveBeenCalled();
  });

  it("includes auth when SMTP_USER is set", async () => {
    stubSmtp();

    await sendMail(mailOpts);

    expect(mockCreateTransport).toHaveBeenCalledWith(
      expect.objectContaining({ auth: { user: "user", pass: "pass" } }),
    );
  });

  it("uses secure transport for port 465", async () => {
    stubSmtp({ SMTP_PORT: "465" });

    await sendMail(mailOpts);

    expect(mockCreateTransport).toHaveBeenCalledWith(
      expect.objectContaining({ port: 465, secure: true }),
    );
  });

  it("uses non-secure transport for port 587", async () => {
    stubSmtp({ SMTP_PORT: "587" });

    await sendMail(mailOpts);

    expect(mockCreateTransport).toHaveBeenCalledWith(
      expect.objectContaining({ port: 587, secure: false }),
    );
  });

  it("caches transport across multiple calls", async () => {
    stubSmtp();

    await sendMail(mailOpts);
    await sendMail(mailOpts);

    expect(mockCreateTransport).toHaveBeenCalledTimes(1);
    expect(mockSendMail).toHaveBeenCalledTimes(2);
  });

  it("propagates sendMail errors to the caller", async () => {
    stubSmtp();
    mockSendMail.mockRejectedValueOnce(new Error("SMTP connection refused"));

    await expect(sendMail(mailOpts)).rejects.toThrow("SMTP connection refused");
  });
});
