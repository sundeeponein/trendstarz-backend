import axios from 'axios';

export async function sendEmailResend({ to, subject, text, html }: { to: string; subject: string; text?: string; html?: string }) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) throw new Error('RESEND_API_KEY not set');

  const payload = {
    from: 'onboarding@resend.dev',
    to,
    subject,
    text,
    html,
  };

  const res = await axios.post('https://api.resend.com/emails', payload, {
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
  });
  return res.data;
}
