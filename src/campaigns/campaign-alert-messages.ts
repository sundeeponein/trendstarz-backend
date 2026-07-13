/**
 * Single source of truth for the "campaign is live" messages shown to
 * creators — both the literal text an admin copies from the campaign review
 * page ("Ready to Share" panel) and the {{n}} params fed into the matching
 * Meta WhatsApp template for the automated send. Previously these were
 * computed independently in the Angular frontend (campaign-alert-message
 * component) and here, which had already drifted once (see git history on
 * whatsapp.templates.ts). Now the frontend fetches the rendered text from
 * GET /admin/campaigns/:id/share-messages (admin-lists.controller.ts) instead
 * of building it itself.
 *
 * WhatsApp Cloud API only allows business-initiated messages that use a
 * template pre-approved by Meta (Business Manager → WhatsApp Manager →
 * Message Templates) — the template's static skeleton (emoji, line layout,
 * hashtags) has to be registered with Meta ahead of time and can't be sent
 * as arbitrary text, so `renderOpenCampaignMessage`/`renderInviteOnlyMessage`
 * (full copy-paste string) and `openCampaignWhatsAppParams`/
 * `inviteOnlyWhatsAppParams` (fixed {{n}} value arrays) are two different
 * renderings of the same `CampaignAlertFields` — not duplicated logic.
 *
 * Submit the two WhatsApp templates as category "Utility". Note: the
 * hashtags and broadcast framing in the open-campaign version read closer to
 * Meta's "Marketing" category, which requires opt-in consent and costs more
 * per message than Utility. If Meta re-categorizes or rejects it as Utility,
 * drop the hashtags/emoji-heavy framing and resubmit, or accept Marketing
 * category + opt-in requirements.
 *
 * campaign_new_match_open template body (7 params — campaign title,
 * location, apply-before date, tier line or "", required creators, accepted
 * count, slots remaining):
 *   🎉 New Collaboration Opportunity on TrendStarz
 *
 *   📢 Campaign: {{1}}
 *
 *   📍 Location: {{2}}
 *   📅 Apply Before: {{3}}
 *
 *   {{4}}
 *   //👥 Required Creators: {{5}}
 *   //✅ Accepted: {{6}}
 *   //🔥 Slots Remaining: {{7}}
 *
 *   We are looking for creators to participate in this campaign.
 *
 *   ✅ Apply directly through TrendStarz:
 *   https://www.trendstarz.in
 *
 *   Login → Campaigns → Apply
 *
 *   Only verified creators are eligible.
 *
 *   #TrendStarz #CreatorCollaboration #InfluencerMarketing
 *
 *   campaign_new_match_invite template body (6 params — campaign title,
 *   location, respond-before date, required creators, accepted count, slots
 *   remaining):
 *   🎉 You've received a new collaboration invitation on TrendStarz
 *
 *   📢 Campaign: {{1}}
 *
 *   Your profile matches the campaign requirements and you have been shortlisted.
 *
 *   📍 Location: {{2}}
 *   📅 Respond Before: {{3}}
 *
 *   //👥 Required Creators: {{4}}
 *   //✅ Accepted: {{5}}
 *   //🔥 Slots Remaining: {{6}}
 *
 *   Please login to TrendStarz to view campaign details and accept your invitation.
 *
 *   https://www.trendstarz.in
 *
 *   Thank you,
 *   TrendStarz Team
 *
 * campaign_approved_owner template body (3 params — owner name, campaign
 * title, campaign URL) — no manual-copy equivalent exists for this one today
 * (the review page only has creator-facing copy):
 *   Hi {{1}}, great news — your campaign/collab "{{2}}" has been approved by
 *   TrendStarz and is now live! Creators can start applying. View it here:
 *   {{3}}
 */

/** Mirrors the pipeline stages counted as "accepted" across the campaign UI/notifications. */
export const ACCEPTED_OR_LATER_STATUSES = [
  "accepted",
  "payment_confirmed",
  "working",
  "submitted",
  "completed",
  "approved",
];

export interface CampaignAlertFields {
  campaignTitle: string;
  location: string;
  applyBeforeLabel: string;
  respondBeforeLabel: string;
  tierLine: string;
  requiredCreators: number;
  acceptedCount: number;
  slotsRemaining: number;
  postingWindowStartLabel: string;
  postingWindowEndLabel: string;
}

export function formatCampaignDateLabel(value: unknown): string {
  const date = value ? new Date(value as any) : null;
  if (!date || isNaN(date.getTime())) return "Not specified";
  return date.toLocaleDateString("en-US", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

function resolveLocationLabel(campaign: any, isPhotographer: boolean): string {
  const district = isPhotographer
    ? campaign?.venueDistrict || campaign?.targetDistrict
    : campaign?.targetDistrict;
  const state = isPhotographer
    ? campaign?.venueState || campaign?.targetState
    : campaign?.targetState;
  return [district, state].filter(Boolean).join(", ") || "Not specified";
}

/** `acceptedCount` must be queried by the caller (campaignInviteModel, status in ACCEPTED_OR_LATER_STATUSES) — kept out of this pure module. */
export function computeCampaignAlertFields(
  campaign: any,
  acceptedCount: number,
): CampaignAlertFields {
  const isPhotographer =
    String(campaign?.inviteRecipientRole || "influencer") === "photographer";
  const requiredCreators =
    Number(campaign?.maxInfluencers || campaign?.inviteSlots || 0) || 0;
  const dateLabel = formatCampaignDateLabel(
    campaign?.acceptanceDeadline || campaign?.endDate || campaign?.timelineEnd,
  );
  return {
    campaignTitle: String(campaign?.title || "Campaign"),
    location: resolveLocationLabel(campaign, isPhotographer),
    applyBeforeLabel: dateLabel,
    respondBeforeLabel: dateLabel,
    tierLine: campaign?.minInfluencerTier
      ? `🏆 Minimum Tier: ${campaign.minInfluencerTier}`
      : "",
    requiredCreators,
    acceptedCount,
    slotsRemaining: Math.max(requiredCreators - acceptedCount, 0),
    postingWindowStartLabel: formatCampaignDateLabel(
      campaign?.timelineStart || campaign?.startDate,
    ),
    postingWindowEndLabel: formatCampaignDateLabel(
      campaign?.timelineEnd || campaign?.endDate,
    ),
  };
}

export function renderOpenCampaignMessage(fields: CampaignAlertFields): string {
  return [
    "🎉 New Collaboration Opportunity on TrendStarz",
    "",
    `📢 Campaign: ${fields.campaignTitle}`,
    "",
    `📍 Location: ${fields.location}`,
    `📅 Apply Before: ${fields.applyBeforeLabel}`,
    "",
    ...(fields.tierLine ? [fields.tierLine] : []),
    //`👥 Required Creators: ${fields.requiredCreators}`,
    //`✅ Accepted: ${fields.acceptedCount}`,
    //`🔥 Slots Remaining: ${fields.slotsRemaining}`,
    //"",
    "We are looking for creators to participate in this campaign.",
    "",
    "✅ Apply directly through TrendStarz:",
    "https://www.trendstarz.in",
    "",
    "Login → Campaigns → Apply",
    "",
    "Only verified creators are eligible.",
    "",
    "#TrendStarzIn #CreatorCollaboration #InfluencerMarketing",
  ].join("\n");
}

export function renderInviteOnlyMessage(fields: CampaignAlertFields): string {
  return [
    "🎉 You've received a new collaboration invitation on TrendStarz",
    "",
    `📢 Campaign: ${fields.campaignTitle}`,
    "",
    "Your profile matches the campaign requirements and you have been shortlisted.",
    "",
    `📍 Location: ${fields.location}`,
    `📅 Respond Before: ${fields.respondBeforeLabel}`,
    "",
    //`👥 Required Creators: ${fields.requiredCreators}`,
    //`✅ Accepted: ${fields.acceptedCount}`,
    //`🔥 Slots Remaining: ${fields.slotsRemaining}`,
    //"",
    "Please login to TrendStarz to view campaign details and accept your invitation.",
    "",
    "https://www.trendstarz.in",
    "",
    "Thank you,",
    "TrendStarz Team",
  ].join("\n");
}

/** Generic, campaign-level nudge (same for every accepted creator) — mirrors the admin review page's manual copy button. */
export function renderPostingReminderMessage(fields: CampaignAlertFields): string {
  return [
    "📅 Reminder: Your TrendStarz campaign",
    "",
    "Hi,",
    "",
    "Your collaboration is scheduled to begin.",
    "",
    `Campaign: ${fields.campaignTitle}`,
    `📆 Posting Window: ${fields.postingWindowStartLabel} – ${fields.postingWindowEndLabel}`,
    "",
    "Please review the campaign resources, caption, hashtags, and promotion link before posting.",
    "",
    "Login to TrendStarz:",
    "https://www.trendstarz.in",
    "",
    "Thank you,",
    "TrendStarz Team",
  ].join("\n");
}

export function openCampaignWhatsAppParams(
  fields: CampaignAlertFields,
): string[] {
  return [
    fields.campaignTitle,
    fields.location,
    fields.applyBeforeLabel,
    fields.tierLine,
    String(fields.requiredCreators),
    String(fields.acceptedCount),
    String(fields.slotsRemaining),
  ];
}

export function inviteOnlyWhatsAppParams(
  fields: CampaignAlertFields,
): string[] {
  return [
    fields.campaignTitle,
    fields.location,
    fields.respondBeforeLabel,
    String(fields.requiredCreators),
    String(fields.acceptedCount),
    String(fields.slotsRemaining),
  ];
}

export function ownerApprovedTemplateParams(args: {
  ownerName: string;
  campaignTitle: string;
  campaignUrl: string;
}): string[] {
  return [args.ownerName, args.campaignTitle, args.campaignUrl];
}

export interface HostEventFields {
  ownerName: string;
  recipientName: string;
  campaignTitle: string;
  campaignUrl: string;
}

/**
 * campaign_invite_accepted_owner template body (4 params — owner name,
 * recipient name, campaign title, campaign URL):
 *   Hi {{1}}, {{2}} accepted your invite for "{{3}}". View it here: {{4}}
 */
export function inviteAcceptedOwnerTemplateParams(
  fields: HostEventFields,
): string[] {
  return [
    fields.ownerName,
    fields.recipientName,
    fields.campaignTitle,
    fields.campaignUrl,
  ];
}

/** Full copy-paste text for the same event — shown to admin in the campaign preview modal per-invite. */
export function renderInviteAcceptedOwnerMessage(
  fields: HostEventFields,
): string {
  return [
    `Hi ${fields.ownerName}, great news!`,
    "",
    `${fields.recipientName} accepted your invite for "${fields.campaignTitle}".`,
    "",
    `Next step: Confirm the invite and complete payment to proceed.`,
    `View & Confirm: ${fields.campaignUrl}`,
  ].join("\n");
}

/**
 * campaign_post_submitted_owner template body (4 params — owner name,
 * recipient name, campaign title, campaign URL):
 *   Hi {{1}}, {{2}} submitted their post for "{{3}}". Review it here: {{4}}
 */
export function postSubmittedOwnerTemplateParams(
  fields: HostEventFields,
): string[] {
  return [
    fields.ownerName,
    fields.recipientName,
    fields.campaignTitle,
    fields.campaignUrl,
  ];
}

/** Full copy-paste text for the same event — shown to admin in the campaign preview modal per-invite. */
export function renderPostSubmittedOwnerMessage(
  fields: HostEventFields,
): string {
  return [
    `Hi ${fields.ownerName},`,
    "",
    `${fields.recipientName} submitted their post for "${fields.campaignTitle}" — it's ready for your review.`,
    "",
    `Review it here: ${fields.campaignUrl}`,
  ].join("\n");
}

/** Mirrors the pipeline stages that imply a submission has happened. */
export const SUBMITTED_OR_LATER_STATUSES = [
  "submitted",
  "completed",
  "approved",
  "disputed",
];

/** Invite statuses that can still owe a post — a reminder makes no sense once submitted/withdrawn/declined. */
export const AWAITING_POST_STATUSES = ["accepted", "payment_confirmed", "working"];

export interface PostingReminderFields {
  recipientName: string;
  campaignTitle: string;
  /** e.g. "48 hours" / "24 hours" / "tomorrow" — kept as a plain phrase so one template covers every milestone. */
  timeframeLabel: string;
  postDateLabel: string;
  campaignUrl: string;
}

/**
 * campaign_posting_reminder template body (5 params — recipient name,
 * campaign title, timeframe phrase, post date, campaign URL). Sent to the
 * CREATOR (not the host) automatically, ahead of their individually selected
 * post date — see sendPostingRemindersCron in campaign-invites.service.ts.
 *   Hi {{1}}, just a reminder — your post for "{{2}}" is due in {{3}} (on
 *   {{4}}). Please review the campaign details and post on time: {{5}}
 */
export function postingReminderTemplateParams(
  fields: PostingReminderFields,
): string[] {
  return [
    fields.recipientName,
    fields.campaignTitle,
    fields.timeframeLabel,
    fields.postDateLabel,
    fields.campaignUrl,
  ];
}

/** Shared feature flag — requires Meta-approved templates + WHATSAPP_CLOUD_API_TOKEN. */
export const ENABLE_CAMPAIGN_WHATSAPP =
  process.env.ENABLE_CAMPAIGN_WHATSAPP === "true";
