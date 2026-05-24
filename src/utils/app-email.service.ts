import { sendEmailResend } from './resend-email.service';
import { sendEmailBrevo } from './brevo-email.service';

export interface AppEmailOptions {
  to: string;
  subject: string;
  text?: string;
  html?: string;
}

const warnedMissingEmailKeys = new Set<string>();

function isProductionEnv(): boolean {
  return (process.env.NODE_ENV || '').toLowerCase() === 'production';
}

function logMissingKeyOnce(provider: string, envKey: string) {
  const key = `${provider}:${envKey}`;
  if (warnedMissingEmailKeys.has(key)) return;
  warnedMissingEmailKeys.add(key);
  console.warn(
    `[sendAppEmail] Skipping ${provider} email delivery in non-production because ${envKey} is not set.`,
  );
}

export async function sendAppEmail(options: AppEmailOptions) {
  const provider = (process.env.EMAIL_PROVIDER || 'resend').toLowerCase();
  if (provider === 'resend') {
    if (!process.env.RESEND_API_KEY && !isProductionEnv()) {
      logMissingKeyOnce('resend', 'RESEND_API_KEY');
      return { skipped: true, provider: 'resend', reason: 'RESEND_API_KEY missing in non-production' };
    }
    return sendEmailResend(options);
  }
  if (provider === 'brevo') {
    if (!process.env.BREVO_API_KEY && !isProductionEnv()) {
      logMissingKeyOnce('brevo', 'BREVO_API_KEY');
      return { skipped: true, provider: 'brevo', reason: 'BREVO_API_KEY missing in non-production' };
    }
    return sendEmailBrevo(options);
  }
  throw new Error(`Unknown EMAIL_PROVIDER: ${provider}`);
}
