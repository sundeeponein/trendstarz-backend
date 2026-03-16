import * as nodemailer from "nodemailer";

export async function sendEmail(to: string, subject: string, text: string) {
  const smtpHost = process.env.SMTP_HOST || "smtp.gmail.com";
  const smtpPort = Number(process.env.SMTP_PORT) || 587;
  const smtpUser = process.env.SMTP_USER;
  const smtpPass = process.env.SMTP_PASS;

  if (!smtpUser || !smtpPass) {
    if (process.env.NODE_ENV === "production") {
      throw new Error(
        "SMTP credentials are missing. Set SMTP_USER and SMTP_PASS.",
      );
    }
    console.warn(
      "[Email:FALLBACK] Missing SMTP credentials; skipping SMTP send in non-production.",
    );
    console.log("[Email:FALLBACK] To:", to);
    console.log("[Email:FALLBACK] Subject:", subject);
    console.log("[Email:FALLBACK] Text:", text);
    return;
  }

  // Configure your SMTP transport (use environment variables for secrets in production)
  const transporter = nodemailer.createTransport({
    host: smtpHost,
    port: smtpPort,
    secure: false,
    auth: {
      user: smtpUser,
      pass: smtpPass,
    },
  });

  const mailOptions = {
    from: process.env.SMTP_FROM || "noreply@trendstarz.com",
    to,
    subject,
    text,
  };

  await transporter.sendMail(mailOptions);
}
