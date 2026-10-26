import type { Collection } from "mongodb";
import { sendEmailBrevo } from "./brevo-email.service";

/** Failed sends (address, subject, provider error — never the body); kept 30 days. */
export const EMAIL_FAILURES = "email_send_failures";
export const EMAIL_FAILURES_KEEP_DAYS = 30;
let failureLog: Collection<any> | null = null;

/** Connected at startup (DataIntegrityService); until then failures are only logged. */
export function setEmailFailureCollection(collection: Collection<any> | null) {
  failureLog = collection;
}

/** Brevo's reason reduced to status + code — never the request or key. */
function describeSendError(err: any): string {
  const status = err?.response?.status;
  const code = err?.response?.data?.code || err?.code;
  const msg = err?.response?.data?.message || err?.message || "error";
  return [status ? `HTTP ${status}` : "", code ? String(code) : "", String(msg)].filter(Boolean).join(" ").slice(0, 200);
}

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
    if (process.env.EMAIL_ALLOW_SKIP === "true") {
      return {
        skipped: true,
        provider: "brevo",
        reason: "BREVO_API_KEY missing",
      };
    }
    throw new Error(
      "Email delivery is not configured: BREVO_API_KEY is missing.",
    );
  }

  try {
    return await sendEmailBrevo(options);
  } catch (err: any) {
    // Most callers swallow email errors (an email must not fail the action), so
    // record it here: an OTP or invite that never left would otherwise be invisible.
    await failureLog
      ?.insertOne({
        at: new Date(),
        to: String(options.to || "").trim().toLowerCase(),
        subject: String(options.subject || "").slice(0, 150),
        error: describeSendError(err),
      })
      .catch(() => undefined);
    throw err;
  }
}
