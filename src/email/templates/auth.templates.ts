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

// ─────────────────────────────────────────────────────────────────────────────
// 1. Email Verification
// ─────────────────────────────────────────────────────────────────────────────

export function verifyEmailTemplate(verifyUrl: string): EmailTemplate {
  const subject = "Verify your Trendstarz email";

  const html = wrapEmail(
    h2("Verify your email") +
      p("Hi,") +
      p(
        "Please verify your Trendstarz email address by clicking the button below:",
      ) +
      btn("Verify Email", verifyUrl) +
      fallbackLink(verifyUrl) +
      p(
        "If you did not request this, you can safely ignore this email.",
        `color:${TEXT_MUTED};font-size:13px;`,
      ),
  );

  const text = `Please verify your Trendstarz email address:\n${verifyUrl}\n\nIf you did not request this, you can safely ignore this email.`;

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
      subject: "Complete your email verification — TrendStarZ",
      heading: "Complete your email verification",
      body: "Your TrendStarZ registration is almost complete. Verify your email address to keep moving toward brand campaign invites.",
      cta: "Verify Email",
    },
    mobile: {
      subject: "Complete your mobile verification — TrendStarZ",
      heading: "Complete your mobile verification",
      body: "You've verified your email — nice. Complete your mobile verification next to activate your profile and become eligible for brand campaign invites.",
      cta: "Verify Mobile",
    },
    incomplete: {
      subject: "Your TrendStarZ registration is still incomplete",
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
  const subject = "Reset your Trendstarz password";

  const html = wrapEmail(
    h2("Reset your password") +
      p("Hi,") +
      p(
        "We received a request to reset your Trendstarz password. Click the button below to choose a new one:",
      ) +
      btn("Reset Password", resetUrl, BRAND_PURPLE) +
      fallbackLink(resetUrl) +
      p(
        "This link expires in <strong>1 hour</strong>. If you did not request a password reset, you can safely ignore this email.",
        `color:${TEXT_MUTED};font-size:13px;`,
      ),
  );

  const text = `Reset your Trendstarz password:\n${resetUrl}\n\nThis link expires in 1 hour.\nIf you did not request this, you can safely ignore this email.`;

  return { subject, html, text };
}
