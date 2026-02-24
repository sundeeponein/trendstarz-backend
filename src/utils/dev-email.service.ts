import * as nodemailer from 'nodemailer';
import { Injectable } from '@nestjs/common';

@Injectable()
export class DevEmailService {
  private transporter: nodemailer.Transporter;

  constructor() {
    this.transporter = nodemailer.createTransport({
      host: process.env.DEV_SMTP_HOST || 'smtp.ethereal.email',
      port: Number(process.env.DEV_SMTP_PORT) || 587,
      secure: false,
      auth: {
        user: process.env.DEV_SMTP_USER || '',
        pass: process.env.DEV_SMTP_PASS || '',
      },
    });
  }

  async sendMail(to: string, subject: string, text: string, html?: string) {
    return this.transporter.sendMail({
      from: process.env.DEV_EMAIL_FROM || 'dev@trendstarz.in',
      to,
      subject,
      text,
      html,
    });
  }
}
