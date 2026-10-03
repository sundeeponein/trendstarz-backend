import * as nodemailer from "nodemailer";
import { Injectable } from "@nestjs/common";

@Injectable()
export class DevEmailService {
  private transporter: nodemailer.Transporter | null = null;
  private readonly hasSmtpCreds: boolean;

  constructor() {
    const host = process.env.DEV_SMTP_HOST || "smtp.ethereal.email";
    const port = Number(process.env.DEV_SMTP_PORT) || 587;
    const user = process.env.DEV_SMTP_USER;
    const pass = process.env.DEV_SMTP_PASS;

    this.hasSmtpCreds = !!(user && pass);

    if (!this.hasSmtpCreds) {
      return;
    }

    this.transporter = nodemailer.createTransport({
      host,
      port,
      secure: false,
      auth: {
        user,
        pass,
      },
    });
  }

  async sendMail(
    to: string,
    subject: string,
    text: string,
    html?: string,
  ): Promise<void> {
    if (!this.transporter || !this.hasSmtpCreds) {
      console.warn(
        "[DevEmailService] DEV_SMTP_USER/DEV_SMTP_PASS not configured. Skipping SMTP send.",
      );
      // FIX #32: Don't log sensitive user info (email addresses, message bodies)
      console.warn("[DevEmailService] Email not sent in dev mode (SMTP not configured).");
      return;
    }

    await this.transporter.sendMail({
      from: process.env.DEV_EMAIL_FROM || "dev@trendstarz.in",
      to,
      subject,
      text,
      html,
    });
  }
}
