import axios from 'axios';

/**
 * trendstarz.in is the domain verified in Brevo (DKIM + DMARC). trendstarz.com
 * has no SPF/DKIM and DMARC p=quarantine, so mail "from" it goes to spam.
 */
export const DEFAULT_SENDER = 'noreply@trendstarz.in';

export async function sendEmailBrevo({ to, subject, text, html }: { to: string; subject: string; text?: string; html?: string }) {
  const apiKey = process.env.BREVO_API_KEY;
  if (!apiKey) throw new Error('BREVO_API_KEY not set');

  const payload = {
    sender: { name: 'TrendStarz', email: process.env.BREVO_FROM || DEFAULT_SENDER },
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
