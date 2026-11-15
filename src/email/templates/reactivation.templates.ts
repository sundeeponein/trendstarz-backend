import { escapeHtmlFields, wrapEmail, h2, p, btn, TEXT_MUTED, EmailTemplate } from '../layout';

// ─────────────────────────────────────────────────────────────────────────────
// "Come back and confirm your profile" email to approved creators who haven't
// been seen in over 90 days (matching 3E, 2026-11-15). Sent only when an admin
// presses Send (Admin → Matching Evidence), once per creator. Same opt-out as
// the offer emails.
// ─────────────────────────────────────────────────────────────────────────────

export interface ReactivationEmailData {
  recipientName: string;
  /** Their own profile page (log in → rates, availability). */
  profileUrl: string;
  unsubscribeUrl: string;
}

export function reactivationEmailTemplate(data: ReactivationEmailData): EmailTemplate {
  // HTML-escaped copies of the typed values, for the html body only.
  const e = escapeHtmlFields(data);
  const subject = 'Brands are inviting creators on Trendstarz: is your profile up to date?';

  const steps = [
    'Log in so brands see you as an active creator.',
    'Check your rates for each platform and content type, and save them.',
    'Set your availability, so you only get invites when you can take them.',
  ];

  const html = wrapEmail(
    h2('Your profile is waiting for brands 👋') +
      p(`Hi <strong>${e.recipientName}</strong>,`) +
      p('Brands on Trendstarz are choosing creators for their campaigns. Creators who are active and have current rates are easier for them to pick.') +
      p('<strong>It takes two minutes:</strong>', 'margin-bottom:6px;') +
      `<ul style="margin:0 0 12px 18px;padding:0;line-height:1.6;">${steps.map((s) => `<li>${s}</li>`).join('')}</ul>` +
      btn('Open my profile', data.profileUrl) +
      p('Invitations depend on what each brand is looking for, so we can\'t promise campaigns, but an up-to-date profile gives you the best chance.', `color:${TEXT_MUTED};font-size:13px;`) +
      p('Team Trendstarz'),
    `You're receiving this because you have a Trendstarz creator account. <a href="${data.unsubscribeUrl}" style="color:#9ca3af;">Stop these emails</a>`,
  );

  const text = [
    `Hi ${data.recipientName},`,
    '',
    'Brands on Trendstarz are choosing creators for their campaigns. Creators who are active and have current rates are easier for them to pick.',
    '',
    'It takes two minutes:',
    ...steps.map((s) => `- ${s}`),
    '',
    `Open my profile: ${data.profileUrl}`,
    '',
    "Invitations depend on what each brand is looking for, so we can't promise campaigns, but an up-to-date profile gives you the best chance.",
    '',
    'Team Trendstarz',
    '',
    `Stop these emails: ${data.unsubscribeUrl}`,
  ].join('\n');

  return { subject, html, text };
}
