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
