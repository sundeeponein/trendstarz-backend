import { wrapEmail, h2, p, TEXT_MUTED, EmailTemplate } from "../layout";

// ─────────────────────────────────────────────────────────────────────────────
// OTP Verification Code
// ─────────────────────────────────────────────────────────────────────────────

export interface OtpData {
  otp: string;
  expiryMinutes?: number;
}

export function otpTemplate(data: OtpData): EmailTemplate {
  const { otp, expiryMinutes = 10 } = data;
  const subject = "Your TrendStarz OTP";

  const html = wrapEmail(
    h2("Your one-time password") +
      p("Use the code below to verify your TrendStarz account:") +
      `<p style="margin:20px 0;text-align:center;">
      <span style="display:inline-block;background:#f0f4ff;border:2px dashed #0d6efd;border-radius:10px;padding:14px 32px;font-size:32px;font-weight:700;letter-spacing:8px;color:#0d6efd;">${otp}</span>
    </p>` +
      p(
        `This code expires in <strong>${expiryMinutes} minutes</strong>.`,
        `color:${TEXT_MUTED};font-size:13px;`,
      ) +
      p(
        "If you did not request this code, please ignore this email.",
        `color:${TEXT_MUTED};font-size:13px;`,
      ),
  );

  const text = `Your TrendStarz OTP is: ${otp}\n\nThis code expires in ${expiryMinutes} minutes.\nIf you did not request this, please ignore this email.`;

  return { subject, html, text };
}
