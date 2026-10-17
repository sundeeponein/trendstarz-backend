/**
 * Commission rates by role and plan (Admin → Settings → "Platform Commission (%)
 * by Role — Host/Payer" and "Recipient Payout Fee (%) by Role"). Each role has the
 * existing (Free) rate and an optional Premium rate; an unset Premium rate means
 * the Free rate applies. Everything is 0 while platform commission is switched off.
 */

export type FeeRole = "brand" | "influencer" | "photographer";

/** Settings field holding the Premium rate for each Free-rate field. */
export const PREMIUM_RATE_FIELDS: Record<string, string> = {
  brandFeePercent: "brandFeePercentPremium",
  influencerFeePercent: "influencerFeePercentPremium",
  photographerFeePercent: "photographerFeePercentPremium",
  influencerRecipientFeePercent: "influencerRecipientFeePercentPremium",
  photographerRecipientFeePercent: "photographerRecipientFeePercentPremium",
};

function percentOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** Premium rate when the user is Premium and one is set; otherwise the Free rate. */
export function rateForPlan(
  freeRate: number,
  premiumRate: unknown,
  isPremium: boolean,
): number {
  const premium = percentOrNull(premiumRate);
  return isPremium && premium !== null ? premium : freeRate;
}

/** True while a user's Premium subscription is active. */
export function isActivePremium(user: any, now: Date = new Date()): boolean {
  if (!user?.isPremium) return false;
  return !user.premiumEnd || new Date(user.premiumEnd) >= now;
}

/**
 * The fee (%) deducted from a creator's payout on a paid collaboration, from raw
 * app settings — the rate locked in when the creator accepts.
 */
export function recipientFeePercentFromSettings(
  settings: any,
  role: "influencer" | "photographer",
  isPremium: boolean,
): number {
  if (!settings?.platformFeeEnabled) return 0;
  const field =
    role === "photographer"
      ? "photographerRecipientFeePercent"
      : "influencerRecipientFeePercent";
  const free = percentOrNull(settings?.[field]) ?? 0;
  return rateForPlan(free, settings?.[PREMIUM_RATE_FIELDS[field]], isPremium);
}
