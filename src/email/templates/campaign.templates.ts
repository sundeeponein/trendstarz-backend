import { wrapEmail, h2, p, btn, TEXT_MUTED, EmailTemplate } from "../layout";

// ─────────────────────────────────────────────────────────────────────────────
// 1. New Campaign Invite
// ─────────────────────────────────────────────────────────────────────────────

export interface NewInviteData {
  recipientName: string;
  senderName: string;
  campaignTitle: string;
  dashboardUrl: string;
}

export function newCampaignInviteTemplate(data: NewInviteData): EmailTemplate {
  const { recipientName, senderName, campaignTitle, dashboardUrl } = data;
  const subject = "New Campaign Invite";

  const html = wrapEmail(
    h2("You have a new invite! 🎉") +
      p(`Hi <strong>${recipientName}</strong>,`) +
      p(
        `<strong>${senderName}</strong> has invited you to collaborate on the campaign:`,
      ) +
      `<p style="margin:12px 0;padding:12px 16px;background:#f0f4ff;border-left:4px solid #0d6efd;border-radius:4px;font-weight:600;">"${campaignTitle}"</p>` +
      p("Log in to TrendStarz to review the invite and respond.") +
      btn("View my invites", dashboardUrl) +
      p(
        "If this does not seem right, you can safely ignore this email.",
        `color:${TEXT_MUTED};font-size:13px;`,
      ),
  );

  const text = `Hi ${recipientName},\n\nYou have a new campaign invite from ${senderName} for "${campaignTitle}".\nLog in to TrendStarz to respond: ${dashboardUrl}`;

  return { subject, html, text };
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Invite Reminder
// ─────────────────────────────────────────────────────────────────────────────

export interface ReminderData {
  recipientName: string;
  brandName: string;
  campaignTitle: string;
  dueDate?: Date | null;
  inviteUrl: string;
}

export function inviteReminderTemplate(data: ReminderData): EmailTemplate {
  const { recipientName, brandName, campaignTitle, dueDate, inviteUrl } = data;
  const subject = `Reminder: ${brandName} is waiting on "${campaignTitle}"`;

  const dueLine = dueDate
    ? `\nDeliverable due: ${new Date(dueDate).toDateString()}.`
    : "";
  const dueHtml = dueDate
    ? `<p style="margin:8px 0;color:#475467;"><strong>Deliverable due:</strong> ${new Date(dueDate).toDateString()}</p>`
    : "";

  const html = wrapEmail(
    h2("Friendly reminder") +
      p(`Hi <strong>${recipientName}</strong>,`) +
      p(
        `<strong>${brandName}</strong> is waiting on your response for the campaign <strong>"${campaignTitle}"</strong>.`,
      ) +
      dueHtml +
      btn("Open my invites", inviteUrl) +
      p(
        "If you have already responded, you can safely ignore this message.",
        `color:${TEXT_MUTED};font-size:13px;`,
      ),
  );

  const text = `Hi ${recipientName},\n\n${brandName} sent you a reminder about the invite for "${campaignTitle}".${dueLine}\n\nPlease open TrendStarz and respond at your earliest convenience: ${inviteUrl}\n\n— TrendStarz`;

  return { subject, html, text };
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. Campaign Invite Accepted
// ─────────────────────────────────────────────────────────────────────────────

export interface InviteAcceptedData {
  brandName: string;
  recipientName: string;
  campaignTitle: string;
  dashboardUrl: string;
}

export function inviteAcceptedTemplate(
  data: InviteAcceptedData,
): EmailTemplate {
  const { brandName, recipientName, campaignTitle, dashboardUrl } = data;
  const subject = "Campaign Invite Accepted ✅";

  const html = wrapEmail(
    h2("Invite accepted!") +
      p(`Hi <strong>${brandName}</strong>,`) +
      p(
        `<strong>${recipientName}</strong> has accepted your campaign invite for:`,
      ) +
      `<p style="margin:12px 0;padding:12px 16px;background:#f0fdf4;border-left:4px solid #16a34a;border-radius:4px;font-weight:600;">"${campaignTitle}"</p>` +
      p("You can monitor their progress from your campaign dashboard.") +
      btn("Go to campaign management", dashboardUrl) +
      p(
        "The creator will be in touch soon.",
        `color:${TEXT_MUTED};font-size:13px;`,
      ),
  );

  const text = `Hi ${brandName},\n\n${recipientName} has accepted your campaign invite for "${campaignTitle}".\nView campaign: ${dashboardUrl}`;

  return { subject, html, text };
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. Post Submitted for Review
// ─────────────────────────────────────────────────────────────────────────────

export interface PostSubmittedData {
  brandName: string;
  influencerName: string;
  campaignTitle: string;
  dashboardUrl: string;
}

export function postSubmittedTemplate(data: PostSubmittedData): EmailTemplate {
  const { brandName, influencerName, campaignTitle, dashboardUrl } = data;
  const subject = "Post Submitted for Review";

  const html = wrapEmail(
    h2("A post is ready for your review") +
      p(`Hi <strong>${brandName}</strong>,`) +
      p(`<strong>${influencerName}</strong> has submitted their post for:`) +
      `<p style="margin:12px 0;padding:12px 16px;background:#f0f4ff;border-left:4px solid #0d6efd;border-radius:4px;font-weight:600;">"${campaignTitle}"</p>` +
      p("Please review it and mark it as approved or raise a dispute.") +
      btn("Review submission", dashboardUrl),
  );

  const text = `Hi ${brandName},\n\n${influencerName} has submitted their post for campaign "${campaignTitle}".\nPlease review it in your dashboard: ${dashboardUrl}`;

  return { subject, html, text };
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. Post Approved by Brand
// ─────────────────────────────────────────────────────────────────────────────

export interface PostApprovedData {
  influencerName: string;
  campaignTitle: string;
  dashboardUrl: string;
}

export function postApprovedTemplate(data: PostApprovedData): EmailTemplate {
  const { influencerName, campaignTitle, dashboardUrl } = data;
  const subject = "Brand approved your post! 🎉";

  const html = wrapEmail(
    h2("Your post has been approved!") +
      p(`Hi <strong>${influencerName}</strong>,`) +
      p(`Great news — the brand has reviewed and approved your post for:`) +
      `<p style="margin:12px 0;padding:12px 16px;background:#f0fdf4;border-left:4px solid #16a34a;border-radius:4px;font-weight:600;">"${campaignTitle}"</p>` +
      p(
        "Your payout is now being processed. You will receive a confirmation once it has been sent.",
      ) +
      btn("View my dashboard", dashboardUrl),
  );

  const text = `Hi ${influencerName},\n\nThe brand has approved your post for campaign "${campaignTitle}".\nYour payout is being processed.\n\nDashboard: ${dashboardUrl}`;

  return { subject, html, text };
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. Auto-Approved After 48 Hours
// ─────────────────────────────────────────────────────────────────────────────

export interface AutoApprovedData {
  influencerName: string;
  campaignTitle: string;
  dashboardUrl: string;
}

export function autoApprovedTemplate(data: AutoApprovedData): EmailTemplate {
  const { influencerName, campaignTitle, dashboardUrl } = data;
  const subject = "Your post was auto-approved ✅";

  const html = wrapEmail(
    h2("Auto-approved after 48 hours") +
      p(`Hi <strong>${influencerName}</strong>,`) +
      p(
        `Your submission for <strong>"${campaignTitle}"</strong> was automatically approved after 48 hours with no brand review.`,
      ) +
      p(
        "Your payout is now queued for processing. You will receive a confirmation email once payment is sent.",
      ) +
      btn("View my dashboard", dashboardUrl) +
      p(
        "Thank you for collaborating with TrendStarz!",
        `color:${TEXT_MUTED};font-size:13px;`,
      ),
  );

  const text = `Hi ${influencerName},\n\nYour submission for "${campaignTitle}" was auto-approved after 48 hours with no brand review.\nPayout is now queued for processing.\n\nDashboard: ${dashboardUrl}`;

  return { subject, html, text };
}

// ─────────────────────────────────────────────────────────────────────────────
// 7. Open Campaign Now Live (broadcast to matching influencers)
// ─────────────────────────────────────────────────────────────────────────────

export interface OpenCampaignLiveData {
  influencerName: string;
  campaignTitle: string;
  brandName: string;
  location: string;
  campaignUrl: string;
}

export function openCampaignLiveTemplate(
  data: OpenCampaignLiveData,
): EmailTemplate {
  const { influencerName, campaignTitle, brandName, location, campaignUrl } =
    data;
  const hasLocation = !!location;
  const subject = hasLocation
    ? `New campaign opportunity in ${location} 🎯`
    : `New open campaign — apply now! 🎯`;

  const locationLine = hasLocation
    ? p(`<strong>${brandName}</strong> has launched a new open campaign that matches your location (<strong>${location}</strong>):`)
    : p(`<strong>${brandName}</strong> has launched a new open campaign — open to creators across India:`);

  const footerNote = hasLocation
    ? `You are receiving this because your profile location matches the campaign's target area.`
    : `You are receiving this because your profile matches this campaign's platform requirements.`;

  const html = wrapEmail(
    h2(hasLocation ? "A new campaign is live near you!" : "A new campaign is live!") +
      p(`Hi <strong>${influencerName}</strong>,`) +
      locationLine +
      `<p style="margin:12px 0;padding:12px 16px;background:#fff7ed;border-left:4px solid #f97316;border-radius:4px;font-weight:600;">"${campaignTitle}"</p>` +
      p(
        "This is an open campaign — you can apply directly from your dashboard. Spots are limited, so apply early!",
      ) +
      btn("View & apply now", campaignUrl) +
      p(footerNote, `color:${TEXT_MUTED};font-size:13px;`),
  );

  const locationCtx = hasLocation ? ` in ${location}` : ` (India-wide)`;
  const text = `Hi ${influencerName},\n\n${brandName} has launched an open campaign: "${campaignTitle}"${locationCtx}.\n\nApply here: ${campaignUrl}\n\n— TrendStarz`;

  return { subject, html, text };
}
