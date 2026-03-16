// For local/dev/testing, you can use Ethereal (https://ethereal.email/) or Gmail SMTP.
// To use Gmail SMTP:
// 1. Enable 2-Step Verification on your Google account.
// 2. Create an App Password (https://myaccount.google.com/apppasswords).
// 3. Use the generated app password as SMTP_PASS below.
// 4. Set SMTP_HOST=smtp.gmail.com, SMTP_PORT=465, SMTP_USER=your@gmail.com, SMTP_PASS=your_app_password, SMTP_FROM=your@gmail.com

import nodemailer from "nodemailer";

export interface EmailProvider {
  send(to: string, subject: string, html: string): Promise<void>;
}

export function getSmtpRuntimeStatus(): {
  nodeEnv: string;
  smtpConfigured: boolean;
  host: string | null;
  port: string | null;
  userMasked: string | null;
  mode: "smtp" | "console-fallback" | "error";
} {
  const host = process.env.SMTP_HOST || null;
  const port = process.env.SMTP_PORT || null;
  const user = process.env.SMTP_USER || "";
  const smtpConfigured = !!(
    process.env.SMTP_HOST &&
    process.env.SMTP_PORT &&
    process.env.SMTP_USER &&
    process.env.SMTP_PASS
  );
  const nodeEnv = process.env.NODE_ENV || "development";

  let userMasked: string | null = null;
  if (user) {
    const [local, domain] = user.split("@");
    const safeLocal = local ? `${local.slice(0, 2)}***` : "***";
    userMasked = domain ? `${safeLocal}@${domain}` : safeLocal;
  }

  const mode: "smtp" | "console-fallback" | "error" =
    nodeEnv === "production"
      ? smtpConfigured
        ? "smtp"
        : "error"
      : smtpConfigured
        ? "smtp"
        : "console-fallback";

  return {
    nodeEnv,
    smtpConfigured,
    host,
    port,
    userMasked,
    mode,
  };
}

// Fallback provider for local development when SMTP credentials are not configured.
export class ConsoleEmailProvider implements EmailProvider {
  async send(to: string, subject: string, html: string): Promise<void> {
    console.warn(
      "[Email:FALLBACK] SMTP credentials missing. Email not sent via SMTP.",
    );
    console.log("[Email:FALLBACK] To:", to);
    console.log("[Email:FALLBACK] Subject:", subject);
    console.log("[Email:FALLBACK] HTML:", html);
  }
}

// Nodemailer provider for dev/local (supports Gmail SMTP or Ethereal)
export class NodemailerProvider implements EmailProvider {
  async send(to: string, subject: string, html: string): Promise<void> {
    const smtpHost = process.env.SMTP_HOST;
    const smtpPort = Number(process.env.SMTP_PORT || 587);
    const smtpUser = process.env.SMTP_USER;
    const smtpPass = process.env.SMTP_PASS;
    const isGmail = smtpHost?.includes("gmail");

    if (!smtpHost || !smtpUser || !smtpPass) {
      throw new Error(
        "SMTP is not fully configured. Please set SMTP_HOST, SMTP_PORT, SMTP_USER, and SMTP_PASS.",
      );
    }

    const transporter = nodemailer.createTransport({
      host: smtpHost,
      port: smtpPort,
      secure: isGmail ? true : false, // Gmail requires secure connection
      auth: {
        user: smtpUser,
        pass: smtpPass,
      },
    });
    await transporter.sendMail({
      from: process.env.SMTP_FROM || process.env.SMTP_USER,
      to,
      subject,
      html,
    });
  }
}

// Example: Production provider (replace with SendGrid/Mailgun/SES as needed)
export class ProductionEmailProvider implements EmailProvider {
  async send(to: string, subject: string, html: string): Promise<void> {
    // Integrate with your real provider here
    // Example: throw new Error('Not implemented');
    console.log(`[PROD] Would send email to ${to}: ${subject}`);
  }
}

// Factory to select provider
export function getEmailProvider(): EmailProvider {
  const smtpConfigured = !!(
    process.env.SMTP_HOST &&
    process.env.SMTP_PORT &&
    process.env.SMTP_USER &&
    process.env.SMTP_PASS
  );

  if (process.env.NODE_ENV === "production") {
    if (smtpConfigured) {
      return new NodemailerProvider();
    }
    throw new Error(
      "SMTP is required in production. Set SMTP_HOST, SMTP_PORT, SMTP_USER, and SMTP_PASS.",
    );
  }

  if (!smtpConfigured) {
    return new ConsoleEmailProvider();
  }

  return new NodemailerProvider();
}
