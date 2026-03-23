import "server-only";

import { createTransport, type Transporter } from "nodemailer";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

interface SmtpConfig {
  host: string;
  port: number;
  user: string;
  pass: string;
  from: string;
}

function loadConfig(): SmtpConfig | null {
  const host = process.env.SMTP_HOST;
  const port = process.env.SMTP_PORT;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  const from = process.env.EMAIL_FROM;

  if (!host || !port || !from) {
    return null;
  }

  return {
    host,
    port: Number.parseInt(port, 10),
    user: user ?? "",
    pass: pass ?? "",
    from,
  };
}

// ---------------------------------------------------------------------------
// Singleton transport + config
// ---------------------------------------------------------------------------

let cached: { transport: Transporter; config: SmtpConfig } | null | undefined;

function getMailer(): { transport: Transporter; config: SmtpConfig } | null {
  if (cached !== undefined) return cached;

  const cfg = loadConfig();
  if (!cfg) {
    console.warn("[email] SMTP not configured — emails will not be sent");
    cached = null;
    return null;
  }

  const transport = createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.port === 465,
    auth: cfg.user ? { user: cfg.user, pass: cfg.pass } : undefined,
  });

  cached = { transport, config: cfg };
  return cached;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface MailOptions {
  to: string;
  subject: string;
  text: string;
  html: string;
}

export async function sendMail(opts: MailOptions): Promise<void> {
  const mailer = getMailer();
  if (!mailer) return;

  await mailer.transport.sendMail({
    from: mailer.config.from,
    to: opts.to,
    subject: opts.subject,
    text: opts.text,
    html: opts.html,
  });
}

/** Reset cached singleton — used by tests. */
export function _resetTransport(): void {
  cached = undefined;
}
