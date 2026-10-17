import {
  wrapEmail,
  h2,
  p,
  btn,
  fallbackLink,
  BRAND_PURPLE,
  TEXT_MUTED,
  EmailTemplate,
} from "../layout";

function escapeHtml(value: string): string {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Email Verification
// ─────────────────────────────────────────────────────────────────────────────

export function verifyEmailTemplate(verifyUrl: string): EmailTemplate {
  const subject = "Verify your TrendStarz email";

  const html = wrapEmail(
    h2("Verify your email") +
      p("Hi,") +
      p(
        "Please verify your TrendStarz email address by clicking the button below:",
      ) +
      btn("Verify Email", verifyUrl) +
      fallbackLink(verifyUrl) +
      p(
        "If you did not request this, you can safely ignore this email.",
        `color:${TEXT_MUTED};font-size:13px;`,
      ),
  );

  const text = `Please verify your TrendStarz email address:\n${verifyUrl}\n\nIf you did not request this, you can safely ignore this email.`;

  return { subject, html, text };
}

// ─────────────────────────────────────────────────────────────────────────────
// 1b. Incomplete-registration nudges (7 / 15 / 30 day) — copy deliberately
// only ever talks about the user's own next step, never retention/deletion
// policy. See PendingUserCleanupService.sendVerificationReminders.
// ─────────────────────────────────────────────────────────────────────────────

export function registrationReminderTemplate(
  stage: "email" | "mobile" | "incomplete",
  loginUrl: string,
): EmailTemplate {
  const copy = {
    email: {
      subject: "Complete your email verification — TrendStarz",
      heading: "Complete your email verification",
      body: "Your TrendStarz registration is almost complete. Verify your email address to keep moving toward brand campaign invites.",
      cta: "Verify Email",
    },
    mobile: {
      subject: "Complete your mobile verification — TrendStarz",
      heading: "Complete your mobile verification",
      body: "You've verified your email — nice. Complete your mobile verification next to activate your profile and become eligible for brand campaign invites.",
      cta: "Verify Mobile",
    },
    incomplete: {
      subject: "Your TrendStarz registration is still incomplete",
      heading: "Your registration is still incomplete",
      body: "Please finish email and mobile verification to activate your profile and start receiving brand campaign invites.",
      cta: "Finish Verification",
    },
  }[stage];

  const html = wrapEmail(
    h2(copy.heading) + p(copy.body) + btn(copy.cta, loginUrl),
  );
  const text = `${copy.body}\n\n${loginUrl}`;

  return { subject: copy.subject, html, text };
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Password Reset
// ─────────────────────────────────────────────────────────────────────────────

export function resetPasswordTemplate(resetUrl: string): EmailTemplate {
  const subject = "Reset your TrendStarz password";

  const html = wrapEmail(
    h2("Reset your password") +
      p("Hi,") +
      p(
        "We received a request to reset your TrendStarz password. Click the button below to choose a new one:",
      ) +
      btn("Reset Password", resetUrl, BRAND_PURPLE) +
      fallbackLink(resetUrl) +
      p(
        "This link expires in <strong>1 hour</strong>. If you requested more than one reset email, use only the most recent link. If you did not request a password reset, you can safely ignore this email.",
        `color:${TEXT_MUTED};font-size:13px;`,
      ),
  );

  const text = `Reset your TrendStarz password:\n${resetUrl}\n\nThis link expires in 1 hour. If you requested more than one reset email, use only the most recent link.\nIf you did not request this, you can safely ignore this email.`;

  return { subject, html, text };
}

/**
 * Admin-issued temporary password (support path for users locked out after a
 * password reset). The password is shown only in this email — never to the admin.
 */
export function temporaryPasswordTemplate(params: {
  name?: string;
  temporaryPassword: string;
  loginUrl: string;
  expiresInHours: number;
}): EmailTemplate {
  const subject = "Your temporary TrendStarz password";
  const greeting = params.name ? `Hi ${escapeHtml(params.name)},` : "Hi,";

  const html = wrapEmail(
    h2("Your temporary password") +
      p(greeting) +
      p(
        "Our support team has reset your TrendStarz password so you can get back into your account. Use this temporary password to log in:",
      ) +
      p(
        `<code style="font-size:18px;letter-spacing:1px;">${escapeHtml(params.temporaryPassword)}</code>`,
      ) +
      btn("Log in to TrendStarz", params.loginUrl, BRAND_PURPLE) +
      p(
        `This temporary password expires in <strong>${params.expiresInHours} hours</strong>. You'll be asked to choose a new password right after you log in.`,
      ) +
      p(
        "If you didn't ask TrendStarz support for help, please reply to this email right away.",
        `color:${TEXT_MUTED};font-size:13px;`,
      ),
  );

  const text = `${params.name ? `Hi ${params.name},` : "Hi,"}\n\nOur support team has reset your TrendStarz password. Log in with this temporary password:\n\n${params.temporaryPassword}\n\n${params.loginUrl}\n\nIt expires in ${params.expiresInHours} hours, and you'll be asked to choose a new password right after you log in.\nIf you didn't ask TrendStarz support for help, please reply to this email right away.`;

  return { subject, html, text };
}
