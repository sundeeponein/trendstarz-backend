import { sendEmailBrevo } from './brevo-email.service';
import { sendEmailResend } from './resend-email.service';
import { sendEmailSes } from './ses-email.service';

export interface AppEmailOptions {
  to: string;
  subject: string;
  text?: string;
  html?: string;
}

const warnedMissingEmailKeys = new Set<string>();

type EmailProvider = 'brevo' | 'resend' | 'ses';

function isProductionEnv(): boolean {
  return (process.env.NODE_ENV || '').toLowerCase() === 'production';
}

function logMissingKeyOnce(provider: EmailProvider, envKey: string) {
  const key = `${provider}:${envKey}`;
  if (warnedMissingEmailKeys.has(key)) return;
  warnedMissingEmailKeys.add(key);
  console.warn(
    `[sendAppEmail] Skipping ${provider} email delivery in non-production because ${envKey} is not set.`,
  );
}

function resolveEmailProvider(): EmailProvider {
  const configured = (process.env.EMAIL_PROVIDER || 'brevo').trim().toLowerCase();
  if (configured === 'brevo' || configured === 'resend' || configured === 'ses') {
    return configured;
  }
  throw new Error(`Unknown EMAIL_PROVIDER: ${configured}`);
}

function hasSesConfig(): boolean {
  return !!(
    process.env.AWS_SES_ACCESS_KEY_ID
    && process.env.AWS_SES_SECRET_ACCESS_KEY
    && (process.env.AWS_SES_FROM || process.env.SES_EMAIL_FROM)
  );
}

export async function sendAppEmail(options: AppEmailOptions) {
  const provider = resolveEmailProvider();

  if (provider === 'brevo') {
    if (!process.env.BREVO_API_KEY && !isProductionEnv()) {
      logMissingKeyOnce('brevo', 'BREVO_API_KEY');
      return { skipped: true, provider, reason: 'BREVO_API_KEY missing in non-production' };
    }
    return sendEmailBrevo(options);
  }

  if (provider === 'resend') {
    if (!process.env.RESEND_API_KEY && !isProductionEnv()) {
      logMissingKeyOnce('resend', 'RESEND_API_KEY');
      return { skipped: true, provider, reason: 'RESEND_API_KEY missing in non-production' };
    }
    return sendEmailResend(options);
  }

  if (!hasSesConfig() && !isProductionEnv()) {
    logMissingKeyOnce('ses', 'AWS_SES_ACCESS_KEY_ID/AWS_SES_SECRET_ACCESS_KEY/AWS_SES_FROM');
    return { skipped: true, provider, reason: 'AWS SES config missing in non-production' };
  }
  return sendEmailSes(options);
}
