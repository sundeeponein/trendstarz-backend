

// For local/dev/testing, you can use Ethereal (https://ethereal.email/) or Gmail SMTP.
// To use Gmail SMTP:
// 1. Enable 2-Step Verification on your Google account.
// 2. Create an App Password (https://myaccount.google.com/apppasswords).
// 3. Use the generated app password as SMTP_PASS below.
// 4. Set SMTP_HOST=smtp.gmail.com, SMTP_PORT=465, SMTP_USER=your@gmail.com, SMTP_PASS=your_app_password, SMTP_FROM=your@gmail.com

import nodemailer from 'nodemailer';

export interface EmailProvider {
  send(to: string, subject: string, html: string): Promise<void>;
}

// Nodemailer provider for dev/local (supports Gmail SMTP or Ethereal)
export class NodemailerProvider implements EmailProvider {
  async send(to: string, subject: string, html: string): Promise<void> {
    const isGmail = process.env.SMTP_HOST?.includes('gmail');
    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT),
      secure: isGmail ? true : false, // Gmail requires secure connection
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
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
  if (process.env.NODE_ENV === 'production') {
    return new ProductionEmailProvider();
  }
  return new NodemailerProvider();
}
