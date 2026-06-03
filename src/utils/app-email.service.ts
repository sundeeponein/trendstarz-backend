import { sendEmailBrevo } from "./brevo-email.service";

export interface AppEmailOptions {
  to: string;
  subject: string;
  text?: string;
  html?: string;
}

const warnedMissingEmailKeys = new Set<string>();

function logMissingBrevoKeyOnce() {
  const key = "brevo:BREVO_API_KEY";
  if (warnedMissingEmailKeys.has(key)) return;
  warnedMissingEmailKeys.add(key);
  console.warn(
    "[sendAppEmail] Skipping brevo email delivery because BREVO_API_KEY is not set.",
  );
}

export async function sendAppEmail(options: AppEmailOptions) {
  if (!process.env.BREVO_API_KEY) {
    logMissingBrevoKeyOnce();
    return {
      skipped: true,
      provider: "brevo",
      reason: "BREVO_API_KEY missing",
    };
  }

  return sendEmailBrevo(options);
}
