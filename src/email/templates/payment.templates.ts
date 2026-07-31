import { wrapEmail, h2, p, btn, kv, TEXT_MUTED, EmailTemplate } from '../layout';

// ─────────────────────────────────────────────────────────────────────────────
// 1. New Payment Proof — Admin Alert
// ─────────────────────────────────────────────────────────────────────────────

export interface PaymentProofAdminData {
  campaignTitle: string;
  utrNumber: string;
  recipientCount: number;
  adminUrl: string;
}

export function paymentProofAdminTemplate(data: PaymentProofAdminData): EmailTemplate {
  const { campaignTitle, utrNumber, recipientCount, adminUrl } = data;
  const subject = `[TrendStarZ] New payment proof — ${campaignTitle}`;

  const html = wrapEmail(
    h2('New payment proof submitted') +
    p(`A brand has submitted a UTR reference for:`) +
    `<p style="margin:12px 0;padding:12px 16px;background:#f0f4ff;border-left:4px solid #0d6efd;border-radius:4px;font-weight:600;">"${campaignTitle}"</p>` +
    kv('UTR', utrNumber) +
    kv('Recipients', String(recipientCount)) +
    btn('Review in admin panel', adminUrl),
  );

  const text = `A brand has submitted a UTR reference for campaign "${campaignTitle}".\n\nUTR: ${utrNumber}\nRecipients: ${recipientCount}\n\nReview: ${adminUrl}`;

  return { subject, html, text };
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Payment Verified — Influencer/Photographer can start posting
// ─────────────────────────────────────────────────────────────────────────────

export interface PaymentVerifiedInfluencerData {
  recipientName: string;
  campaignTitle: string;
  dashboardUrl: string;
}

export function paymentVerifiedInfluencerTemplate(data: PaymentVerifiedInfluencerData): EmailTemplate {
  const { recipientName, campaignTitle, dashboardUrl } = data;
  const subject = '[TrendStarZ] Verified — you can start posting';

  const html = wrapEmail(
    h2('Payment verified — you can start posting! ✅') +
    p(`Hi <strong>${recipientName}</strong>,`) +
    p(`Good news! The brand payment has been verified for:`) +
    `<p style="margin:12px 0;padding:12px 16px;background:#f0fdf4;border-left:4px solid #16a34a;border-radius:4px;font-weight:600;">"${campaignTitle}"</p>` +
    p('You can now start creating and posting your content.') +
    btn('Open my dashboard', dashboardUrl) +
    p('Thank you for collaborating with TrendStarz!', `color:${TEXT_MUTED};font-size:13px;`),
  );

  const text = `Hi ${recipientName},\n\nGood news! Brand payment has been verified for "${campaignTitle}".\nYou can now start creating and posting your content.\n\nOpen dashboard: ${dashboardUrl}`;

  return { subject, html, text };
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. Payment Verified — Brand confirmation
// ─────────────────────────────────────────────────────────────────────────────

export interface PaymentVerifiedBrandData {
  brandName: string;
  dashboardUrl: string;
}

export function paymentVerifiedBrandTemplate(data: PaymentVerifiedBrandData): EmailTemplate {
  const { brandName, dashboardUrl } = data;
  const subject = '[TrendStarZ] Payment verified — influencers can now begin work';

  const html = wrapEmail(
    h2('Payment verified! 🎉') +
    p(`Hi <strong>${brandName}</strong>,`) +
    p('Your campaign payment has been verified. Influencers have been notified and can now begin creating content.') +
    btn('Monitor campaign progress', dashboardUrl) +
    p('You will receive updates as creators submit their work.', `color:${TEXT_MUTED};font-size:13px;`),
  );

  const text = `Hi ${brandName},\n\nYour campaign payment has been verified. Influencers have been notified and can now begin creating content.\n\nMonitor progress: ${dashboardUrl}`;

  return { subject, html, text };
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. Payment Proof Rejected — Brand action required
// ─────────────────────────────────────────────────────────────────────────────

export interface PaymentRejectedData {
  brandName: string;
  reason: string;
  resubmitUrl: string;
}

export function paymentRejectedTemplate(data: PaymentRejectedData): EmailTemplate {
  const { brandName, reason, resubmitUrl } = data;
  const subject = '[TrendStarZ] Action required — payment proof could not be verified';

  const html = wrapEmail(
    h2('Payment proof could not be verified') +
    p(`Hi <strong>${brandName}</strong>,`) +
    p('Unfortunately, your payment proof could not be verified.') +
    `<p style="margin:12px 0;padding:12px 16px;background:#fff7ed;border-left:4px solid #f97316;border-radius:4px;">
      <strong>Reason:</strong> ${reason || 'No reason provided.'}
    </p>` +
    p('Please resubmit with a valid UTR reference.') +
    btn('Resubmit payment proof', resubmitUrl) +
    p('If you believe this is an error, please contact support.', `color:${TEXT_MUTED};font-size:13px;`),
  );

  const text = `Hi ${brandName},\n\nUnfortunately, your payment proof could not be verified.\n\nReason: ${reason || 'No reason provided.'}\n\nPlease resubmit with a valid UTR reference: ${resubmitUrl}`;

  return { subject, html, text };
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. Payout Sent — Influencer/Photographer
// ─────────────────────────────────────────────────────────────────────────────

export interface PayoutSentData {
  recipientName: string;
  amount: string;          // pre-formatted, e.g. "₹1,200.00"
  upiId: string | null;
  payoutUtr: string;
}

export function payoutSentTemplate(data: PayoutSentData): EmailTemplate {
  const { recipientName, amount, upiId, payoutUtr } = data;
  const subject = '[TrendStarZ] Your payout has been sent! 🎉';

  const html = wrapEmail(
    h2('Your payout has been sent!') +
    p(`Hi <strong>${recipientName}</strong>,`) +
    p(`Great news! <strong>${amount}</strong> has been sent to your UPI account:`) +
    kv('UPI account', upiId || 'on file') +
    kv('UTR Reference', payoutUtr) +
    p('Funds typically arrive within minutes. Contact your bank if they do not arrive within 24 hours.', `color:${TEXT_MUTED};font-size:13px;margin-top:16px;`) +
    p('Thank you for collaborating with TrendStarz!', `color:${TEXT_MUTED};font-size:13px;`),
  );

  const text = `Hi ${recipientName},\n\nGreat news! ${amount} has been sent to your UPI account (${upiId || 'on file'}).\n\nUTR Reference: ${payoutUtr}\n\nThank you for collaborating with TrendStarZ!`;

  return { subject, html, text };
}
