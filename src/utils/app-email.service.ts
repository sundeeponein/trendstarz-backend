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
  const configured = (process.env.EMAIL_PROVIDER || 'resend').trim().toLowerCase();
  if (configured === 'brevo' || configured === 'resend' || configured === 'ses') {
    return configured;
  }
  throw new Error(`Unknown EMAIL_PROVIDER: ${configured}`);
}

function isEmailProvider(value: string): value is EmailProvider {
  return value === 'brevo' || value === 'resend' || value === 'ses';
}

function resolveFallbackProviders(): EmailProvider[] {
  const raw = process.env.EMAIL_FALLBACK_PROVIDERS || 'ses';
  return raw
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter(isEmailProvider);
}

function resolveProviderOrder(): EmailProvider[] {
  const order: EmailProvider[] = [resolveEmailProvider(), ...resolveFallbackProviders()];
  return order.filter((provider, index) => order.indexOf(provider) === index);
}

function hasSesConfig(): boolean {
  return !!(
    process.env.AWS_SES_ACCESS_KEY_ID
    && process.env.AWS_SES_SECRET_ACCESS_KEY
    && (process.env.AWS_SES_FROM || process.env.SES_EMAIL_FROM)
  );
}

function hasProviderConfig(provider: EmailProvider): boolean {
  if (provider === 'brevo') {
    return !!process.env.BREVO_API_KEY;
  }
  if (provider === 'resend') {
    return !!process.env.RESEND_API_KEY;
  }
  return hasSesConfig();
}

function missingConfigReason(provider: EmailProvider): string {
  if (provider === 'brevo') return 'BREVO_API_KEY missing';
  if (provider === 'resend') return 'RESEND_API_KEY missing';
  return 'AWS SES config missing';
}

async function sendWithProvider(provider: EmailProvider, options: AppEmailOptions) {
  if (provider === 'brevo') return sendEmailBrevo(options);
  if (provider === 'resend') return sendEmailResend(options);
  return sendEmailSes(options);
}

export async function sendAppEmail(options: AppEmailOptions) {
  const failures: string[] = [];

  for (const provider of resolveProviderOrder()) {
    if (!hasProviderConfig(provider)) {
      const reason = missingConfigReason(provider);
      failures.push(`${provider}: ${reason}`);
      if (!isProductionEnv()) {
        logMissingKeyOnce(
          provider,
          provider === 'ses'
            ? 'AWS_SES_ACCESS_KEY_ID/AWS_SES_SECRET_ACCESS_KEY/AWS_SES_FROM'
            : provider === 'brevo'
              ? 'BREVO_API_KEY'
              : 'RESEND_API_KEY',
        );
      }
      continue;
    }

    try {
      return await sendWithProvider(provider, options);
    } catch (error: any) {
      failures.push(`${provider}: ${error?.message || 'delivery failed'}`);
      console.warn(`[sendAppEmail] ${provider} delivery failed; checking fallback providers.`);
    }
  }

  if (!isProductionEnv()) {
    return {
      skipped: true,
      provider: resolveEmailProvider(),
      reason: failures.join('; ') || 'No email provider configured',
    };
  }

  throw new Error(`Email delivery failed: ${failures.join('; ') || 'No email provider configured'}`);
}
