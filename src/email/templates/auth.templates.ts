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
