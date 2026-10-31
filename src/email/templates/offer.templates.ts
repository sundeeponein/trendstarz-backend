import { escapeHtml, escapeHtmlFields, wrapEmail, h2, p, btn, TEXT_MUTED, EmailTemplate } from '../layout';

// ─────────────────────────────────────────────────────────────────────────────
// Premium offer email to free creators — sent only when an admin presses Send
// (Admin → Plans → Email offer). Prices come from the live plan, so the email
// always says what checkout will charge.
// ─────────────────────────────────────────────────────────────────────────────

export type OfferEmailKind = 'launch' | 'reminder';

export interface OfferEmailData {
  kind: OfferEmailKind;
  recipientName: string;
  /** e.g. "Diwali Offer" — the plan's popup title. */
  offerName: string;
  /** "₹947" */
  yearlyOfferPrice: string;
  /** "₹3,789" */
  yearlyPrice: string;
  /** "10 November, 11:59 PM IST" */
  endsAtLabel: string;
  /** Admin-edited lines; plain text, escaped here. */
  benefits: string[];
  upgradeUrl: string;
  unsubscribeUrl: string;
}

const TERMS =
  'Membership lasts 1 year from activation and does not auto-renew. When it ends, you can renew at the offer price running at that time, or the standard {yearlyPrice}/year. No refunds once activated. No GST is charged.';

const DISCLAIMER =
  'Membership gives you access to the Trendstarz creator platform and eligibility for relevant brand campaigns. Invitations and selection depend on brand requirements, creator suitability and campaign availability. Membership does not guarantee paid campaigns, selection or earnings.';

export function offerEmailTemplate(data: OfferEmailData): EmailTemplate {
  // HTML-escaped copies of the typed values, for the html body only.
  const e = escapeHtmlFields(data);
  const terms = TERMS.replace('{yearlyPrice}', data.yearlyPrice);
  const benefits = data.benefits.map((b) => b.trim()).filter(Boolean);

  const subject =
    data.kind === 'reminder'
      ? `Last days: Premium Creator Membership at ${data.yearlyOfferPrice}/year`
      : `${data.offerName}: Premium Creator Membership at ${data.yearlyOfferPrice}/year`;

  const intro =
    data.kind === 'reminder'
      ? p(`The ${e.offerName} ends <strong>${e.endsAtLabel}</strong>. After that, the yearly membership is ${e.yearlyPrice}/year.`)
      : p(`Upgrade to <strong>Premium Creator Membership</strong> for <strong>${e.yearlyOfferPrice} for 1 year</strong> (standard price ${e.yearlyPrice}/year).`);

  const benefitsHtml = benefits.length
    ? p('<strong>What you get with Premium</strong>', 'margin-bottom:6px;') +
      `<ul style="margin:0 0 12px 18px;padding:0;line-height:1.6;">${benefits.map((b) => `<li>${escapeHtml(b)}</li>`).join('')}</ul>`
    : '';

  const html = wrapEmail(
    h2(data.kind === 'reminder' ? 'Offer ending soon ⏳' : `${e.offerName} 🪔`) +
      p(`Hi <strong>${e.recipientName}</strong>,`) +
      intro +
      (data.kind === 'launch' ? benefitsHtml : '') +
      p(`<strong>Offer ends ${e.endsAtLabel}.</strong>`) +
      btn('Upgrade now', data.upgradeUrl) +
      p(escapeHtml(terms), `color:${TEXT_MUTED};font-size:13px;`) +
      p(DISCLAIMER, `color:${TEXT_MUTED};font-size:13px;`) +
      p('Team Trendstarz'),
    `You're receiving this because you have a Trendstarz creator account. <a href="${data.unsubscribeUrl}" style="color:#9ca3af;">Stop offer emails</a>`,
  );

  const text = [
    `Hi ${data.recipientName},`,
    '',
    data.kind === 'reminder'
      ? `The ${data.offerName} ends ${data.endsAtLabel}. After that, the yearly membership is ${data.yearlyPrice}/year.`
      : `Upgrade to Premium Creator Membership for ${data.yearlyOfferPrice} for 1 year (standard price ${data.yearlyPrice}/year).`,
    ...(data.kind === 'launch' && benefits.length
      ? ['', 'What you get with Premium:', ...benefits.map((b) => `- ${b}`)]
      : []),
    '',
    `Offer ends ${data.endsAtLabel}.`,
    `Upgrade now: ${data.upgradeUrl}`,
    '',
    terms,
    '',
    DISCLAIMER,
    '',
    'Team Trendstarz',
    '',
    `Stop offer emails: ${data.unsubscribeUrl}`,
  ].join('\n');

  return { subject, html, text };
}
