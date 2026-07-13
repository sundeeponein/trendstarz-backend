/**
 * WhatsApp Cloud API only allows business-initiated messages that use a
 * template pre-approved by Meta (Business Manager → WhatsApp Manager →
 * Message Templates). The bodies below intentionally MIRROR the copy admins
 * already manually copy/paste today from the "Ready to Share" panel in the
 * campaign review page (see
 * trendstarz-frontend/src/app/shared/campaign-alert-message/campaign-alert-message.component.ts
 * — openCampaignMessage / inviteOnlyMessage) so the automated send reads
 * identically to what's already proven in production.
 *
 * Submit these two as category "Utility". Note: the hashtags and broadcast
 * framing in the open-campaign version read closer to Meta's "Marketing"
 * category, which requires opt-in consent and costs more per message than
 * Utility. If Meta re-categorizes or rejects it as Utility, drop the
 * hashtags/emoji-heavy framing and resubmit, or accept Marketing category +
 * opt-in requirements.
 *
 * ── campaign_new_match_open (tier_filtered_open campaigns) ────────────────
 * 🎉 New Collaboration Opportunity on TrendStarz
 *
 * 📢 Campaign: {{1}}
 *
 * 📍 Location: {{2}}
 * 📅 Apply Before: {{3}}
 *
 * {{4}}
 * 👥 Required Creators: {{5}}
 * ✅ Accepted: {{6}}
 * 🔥 Slots Remaining: {{7}}
 *
 * We are looking for creators to participate in this campaign.
 *
 * ✅ Apply directly through TrendStarz:
 * https://www.trendstarz.in
 *
 * Login → Campaigns → Apply
 *
 * Only verified creators are eligible.
 *
 * #TrendStarz #CreatorCollaboration #InfluencerMarketing
 * (params: campaign title, location, apply-before date, tier line or "",
 * required creators, accepted count, slots remaining)
 *
 * ── campaign_new_match_invite (invite_only campaigns) ──────────────────────
 * You've received a new collaboration invitation on TrendStarz
 *
 * Campaign: {{1}}
 *
 * Your profile matches the campaign requirements and you have been shortlisted.
 *
 * Location: {{2}}
 * Respond Before: {{3}}
 *
 * Required Creators: {{4}}
 * Accepted: {{5}}
 * Slots Remaining: {{6}}
 *
 * Please login to TrendStarz to view campaign details and accept your invitation.
 *
 * https://www.trendstarz.in
 *
 * Thank you,
 * TrendStarz Team
 * (params: campaign title, location, respond-before date, required creators,
 * accepted count, slots remaining)
 *
 * ── campaign_approved_owner ─────────────────────────────────────────────
 * No manual-copy equivalent exists for this one today (the review page only
 * has creator-facing copy) — this is new draft text for the campaign owner:
 *
 * Hi {{1}}, great news — your campaign/collab "{{2}}" has been approved by
 * TrendStarz and is now live! Creators can start applying. View it here:
 * {{3}}
 */

export function openCampaignTemplateParams(args: {
  campaignTitle: string;
  location: string;
  applyBeforeLabel: string;
  tierLine?: string;
  requiredCreators: number;
  acceptedCount: number;
  slotsRemaining: number;
}): string[] {
  return [
    args.campaignTitle,
    args.location,
    args.applyBeforeLabel,
    args.tierLine || "",
    String(args.requiredCreators),
    String(args.acceptedCount),
    String(args.slotsRemaining),
  ];
}

export function inviteOnlyTemplateParams(args: {
  campaignTitle: string;
  location: string;
  respondBeforeLabel: string;
  requiredCreators: number;
  acceptedCount: number;
  slotsRemaining: number;
}): string[] {
  return [
    args.campaignTitle,
    args.location,
    args.respondBeforeLabel,
    String(args.requiredCreators),
    String(args.acceptedCount),
    String(args.slotsRemaining),
  ];
}

export function ownerApprovedTemplateParams(args: {
  ownerName: string;
  campaignTitle: string;
  campaignUrl: string;
}): string[] {
  return [args.ownerName, args.campaignTitle, args.campaignUrl];
}
