/**
 * WhatsApp templates added for account, Premium and campaign-money events —
 * the exact text to submit in Meta Business Manager → WhatsApp Manager →
 * Message templates, and the switch that turns each one on.
 *
 * Nothing here sends until BOTH are true:
 *  1. WHATSAPP_CLOUD_API_TOKEN + WHATSAPP_PHONE_NUMBER_ID are set (Railway), and
 *  2. the template's name is listed in WHATSAPP_TEMPLATES (comma-separated, or
 *     "all") — add a name only after Meta shows it as Approved.
 *
 * Older templates (campaign_* alerts, verification reminders) keep their own
 * switches (ENABLE_CAMPAIGN_WHATSAPP / credentials) while WHATSAPP_TEMPLATES is
 * unset; once it is set, it controls every template.
 *
 * Keep the text purely informational — no prices, offers or discounts — or Meta
 * re-categorises it as Marketing (higher cost, needs opt-in).
 */

export interface WhatsAppTemplateSpec {
  name: string;
  category: "UTILITY";
  /** What each {{n}} is, in order. */
  params: string[];
  /** Body text exactly as it should be submitted to Meta. */
  body: string;
  /** When it is sent. */
  trigger: string;
}

export const NEW_WHATSAPP_TEMPLATES: WhatsAppTemplateSpec[] = [
  {
    name: "welcome_user",
    category: "UTILITY",
    params: ["display name", "dashboard link"],
    trigger: "Once, within ~15 minutes of a new account being created (any role).",
    body:
      "Hi {{1}}, welcome to TrendStarz! 👋\n\nYour account is ready. Complete your profile so brands and creators can find you: {{2}}\n\nYou'll get important updates about your account and collaborations on this number.",
  },
  {
    name: "premium_activated",
    category: "UTILITY",
    params: ["display name", "plan name", "valid until date", "dashboard link"],
    trigger: "When Premium starts: Razorpay payment confirmed, admin approves a UPI/QR payment, or admin grants Premium.",
    body:
      "Hi {{1}}, your {{2}} is now active ✅\n\nValid until: {{3}}\n\nOpen your dashboard: {{4}}",
  },
  {
    name: "campaign_payment_received_host",
    category: "UTILITY",
    params: ["host name", "campaign title", "creator name", "campaigns link"],
    trigger: "When TrendStarz confirms the host's payment for an accepted creator (UTR verified by admin or Razorpay confirmed).",
    body:
      "Hi {{1}}, we have received your payment for \"{{2}}\" ✅\n\n{{3}} can now start working on the campaign. Track progress here: {{4}}",
  },
  {
    name: "campaign_start_posting",
    category: "UTILITY",
    params: ["creator name", "campaign title", "dashboard link"],
    trigger: "Same moment as campaign_payment_received_host, to the creator.",
    body:
      "Hi {{1}}, payment for \"{{2}}\" is confirmed ✅\n\nYou can start creating and posting your content now. Details: {{3}}",
  },
  {
    name: "campaign_post_approved",
    category: "UTILITY",
    params: ["creator name", "campaign title", "dashboard link"],
    trigger: "When the host approves the creator's submitted post.",
    body:
      "Hi {{1}}, your post for \"{{2}}\" was approved 🎉\n\nYour payout is now being processed. Details: {{3}}",
  },
  {
    name: "campaign_changes_requested",
    category: "UTILITY",
    params: ["creator name", "campaign title", "reason", "dashboard link"],
    trigger: "When the host disputes a submission the first time (creator can fix and resubmit within 12 hours).",
    body:
      "Hi {{1}}, the host asked for changes to your post for \"{{2}}\".\n\nReason: {{3}}\n\nPlease review and resubmit within 12 hours: {{4}}",
  },
  {
    name: "campaign_submission_under_review",
    category: "UTILITY",
    params: ["creator name", "campaign title", "dashboard link"],
    trigger: "When the host rejects the resubmission — it goes to TrendStarz review and the payout is on hold.",
    body:
      "Hi {{1}}, the host did not accept your resubmitted post for \"{{2}}\".\n\nThe TrendStarz team will review it and update you. Details: {{3}}",
  },
];

/** Templates that existed before WHATSAPP_TEMPLATES and keep their old switches while it is unset. */
const LEGACY_TEMPLATES = new Set([
  "campaign_approved_owner",
  "campaign_new_match_open",
  "campaign_new_match_invite",
  "campaign_invite_accepted_owner",
  "campaign_post_submitted_owner",
  "campaign_posting_reminder",
  "email_verification_reminder",
  "profile_photo_not_verified",
  "mobile_otp_verification_reminder",
  "mobile_verification_call_reminder",
]);

/** Names listed in WHATSAPP_TEMPLATES, or "all" / null (unset). */
export function enabledWhatsAppTemplates(env: NodeJS.ProcessEnv = process.env): Set<string> | "all" | null {
  const raw = String(env.WHATSAPP_TEMPLATES || "").trim();
  if (!raw) return null;
  if (raw.toLowerCase() === "all") return "all";
  return new Set(raw.split(",").map((s) => s.trim()).filter(Boolean));
}

/**
 * Whether this template may be sent. `newUse` marks a new automatic use of an
 * older template (e.g. the mobile reminder, until now admin-button only): it
 * needs the template listed too, so turning on credentials alone changes nothing.
 */
export function isWhatsAppTemplateEnabled(
  name: string,
  opts: { newUse?: boolean } = {},
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const enabled = enabledWhatsAppTemplates(env);
  if (enabled === "all") return true;
  if (enabled) return enabled.has(name);
  return LEGACY_TEMPLATES.has(name) && !opts.newUse;
}

/** "31 Oct 2027" in India time. */
export function whatsAppDate(d: Date | string | null | undefined): string {
  if (!d) return "-";
  const date = new Date(d);
  if (!Number.isFinite(date.getTime())) return "-";
  return new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kolkata" }).format(date);
}

/** Meta rejects empty params and params with newlines/tabs or 4+ spaces. */
export function whatsAppParam(value: unknown, fallback = "-"): string {
  const text = String(value ?? "").replace(/[\r\n\t]+/g, " ").replace(/ {4,}/g, " ").trim().slice(0, 300);
  return text || fallback;
}
