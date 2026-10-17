/**
 * Barter (product-only) and invite-to-location campaigns: unpaid, so they get
 * smaller limits inside the host's monthly campaign slots (decided 2026-10-13):
 *  - at most N of the month's slots may be barter/location (Premium: 2 of 3);
 *  - their own invites-per-campaign limit (3);
 *  - at most 1 accepted creator per campaign.
 * Admin-editable as plan limits; the defaults apply when a plan doesn't set them.
 * "Product + Paid" moves money, so it counts as a paid campaign, not barter.
 */

export const BARTER_CAMPAIGNS_PER_MONTH_KEY = "maxBarterCampaignsPerMonth";
export const BARTER_INVITES_PER_CAMPAIGN_KEY = "maxInvitesPerBarterCampaign";
export const BARTER_ACCEPTED_PER_CAMPAIGN_KEY = "maxAcceptedPerBarterCampaign";

const DEFAULTS = {
  perMonth: 2,
  invitesPerCampaign: 3,
  acceptedPerCampaign: 1,
};

/** Mongo match for barter/location campaigns. */
export const BARTER_CAMPAIGN_MATCH = {
  $or: [
    { campaignType: "invite_location" },
    { campaignType: "product", productPaymentMode: { $ne: "product_plus_payment" } },
  ],
};

export function isBarterOrLocationCampaign(campaign: any): boolean {
  const type = String(campaign?.campaignType || "").toLowerCase();
  if (type === "invite_location") return true;
  return (
    type === "product" &&
    String(campaign?.productPaymentMode || "") !== "product_plus_payment"
  );
}

function limitValue(limits: unknown, key: string, fallback: number): number {
  const row = (Array.isArray(limits) ? limits : []).find(
    (l: any) => l?.key === key,
  );
  const v = Number(row?.value);
  return row && Number.isFinite(v) ? v : fallback;
}

/** -1 = unlimited for every value. */
export function barterLimitsFrom(limits: unknown) {
  return {
    perMonth: limitValue(limits, BARTER_CAMPAIGNS_PER_MONTH_KEY, DEFAULTS.perMonth),
    invitesPerCampaign: limitValue(
      limits,
      BARTER_INVITES_PER_CAMPAIGN_KEY,
      DEFAULTS.invitesPerCampaign,
    ),
    acceptedPerCampaign: limitValue(
      limits,
      BARTER_ACCEPTED_PER_CAMPAIGN_KEY,
      DEFAULTS.acceptedPerCampaign,
    ),
  };
}

/**
 * Caps a barter/location campaign's accepted-creator numbers (maxInfluencers,
 * minInfluencers, per-role inviteSlots) at `cap`. Mutates and
 * returns `target`; no-op for other campaign types or an unlimited cap.
 */
export function capBarterAcceptance<T extends Record<string, any>>(
  target: T,
  campaign: any,
  cap: number,
): T {
  if (!isBarterOrLocationCampaign(campaign) || !(cap > 0)) return target;
  const clamp = (v: unknown) => {
    const n = Number(v);
    return Number.isFinite(n) && n > cap ? cap : v;
  };
  (target as any).maxInfluencers = clamp(campaign?.maxInfluencers ?? cap);
  if (campaign?.minInfluencers !== undefined)
    (target as any).minInfluencers = clamp(campaign.minInfluencers);
  if (Array.isArray(campaign?.inviteSlots)) {
    (target as any).inviteSlots = campaign.inviteSlots.map((slot: any) => ({
      ...(slot?.toObject ? slot.toObject() : slot),
      count: clamp(slot?.count),
    }));
  }
  return target;
}

/**
 * Fixed platform fee (paise) for one confirmed creator on a barter/location
 * campaign, from admin settings (₹; 0 = off). 0 for every other campaign type.
 */
export function platformFeeFor(campaign: any, settings: any): number {
  if (!isBarterOrLocationCampaign(campaign)) return 0;
  const rupees = Number(
    String(campaign?.campaignType || "") === "invite_location"
      ? settings?.locationPlatformFee
      : settings?.barterPlatformFee,
  );
  return Number.isFinite(rupees) && rupees > 0 ? Math.round(rupees * 100) : 0;
}

/** Accepted, owes a platform fee, not confirmed yet — the creator can't start. */
export function awaitingPlatformFee(invite: any): boolean {
  return Number(invite?.platformFeeDue || 0) > 0 && !invite?.platformFeePaidAt;
}
