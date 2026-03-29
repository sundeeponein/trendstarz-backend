import axios from 'axios';

export async function sendEmailBrevo({ to, subject, text, html }: { to: string; subject: string; text?: string; html?: string }) {
  const apiKey = process.env.BREVO_API_KEY;
  if (!apiKey) throw new Error('BREVO_API_KEY not set');

  const payload = {
    sender: { name: 'Trendstarz', email: process.env.BREVO_FROM || 'noreply@trendstarz.com' },
    to: [{ email: to }],
    subject,
    htmlContent: html || text,
    textContent: text,
  };

  const res = await axios.post('https://api.brevo.com/v3/smtp/email', payload, {
    headers: {
      'api-key': apiKey,
      'Content-Type': 'application/json',
    },
  });
  return res.data;
}
