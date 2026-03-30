import { sendEmailResend } from './resend-email.service';
import { sendEmailBrevo } from './brevo-email.service';

export interface AppEmailOptions {
  to: string;
  subject: string;
  text?: string;
  html?: string;
}

export async function sendAppEmail(options: AppEmailOptions) {
  const provider = (process.env.EMAIL_PROVIDER || 'resend').toLowerCase();
  if (provider === 'resend') {
    return sendEmailResend(options);
  }
  if (provider === 'brevo') {
    return sendEmailBrevo(options);
  }
  throw new Error(`Unknown EMAIL_PROVIDER: ${provider}`);
}
