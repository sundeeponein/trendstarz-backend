import { securityAlertTemplate } from "../email/templates/auth.templates";
import { sendAppEmail } from "./app-email.service";

/** "as***@gmail.com" — recognisable to the owner, not reusable. */
export function maskEmail(value: unknown): string {
  const email = String(value ?? "").trim().toLowerCase();
  const [name, domain] = email.split("@");
  if (!name || !domain) return "***";
  return `${name.slice(0, 2)}***@${domain}`;
}

/**
 * Tells the account owner that a sign-in detail changed (email, password), so
 * a takeover doesn't go unnoticed. Best effort: never blocks the change.
 */
export function sendSecurityAlert(to: unknown, change: string, name?: string) {
  const address = String(to ?? "").trim();
  if (!address || !address.includes("@") || address.endsWith(".invalid")) return;
  const frontend = process.env.FRONTEND_URL || "https://www.trendstarz.in";
  sendAppEmail({
    to: address,
    ...securityAlertTemplate({ name, change, settingsUrl: `${frontend}/settings` }),
  }).catch((err: unknown) => console.error("[security] alert email failed:", err));
}
