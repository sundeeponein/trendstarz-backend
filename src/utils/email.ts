import * as nodemailer from 'nodemailer';

export async function sendEmail(to: string, subject: string, text: string) {
  // Configure your SMTP transport (use environment variables for secrets in production)
  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port: Number(process.env.SMTP_PORT) || 587,
    secure: false,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });

  const mailOptions = {
    from: process.env.SMTP_FROM || 'noreply@trendstarz.com',
    to,
    subject,
    text,
  };

  await transporter.sendMail(mailOptions);
}
