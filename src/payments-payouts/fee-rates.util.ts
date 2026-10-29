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

/**
 * GST (%) charged on the creator's payout fee, from raw app settings: the
 * platform GST rate, but only once an admin turned on "Charge GST on creator
 * payout fee" (default off — until the accountant confirms the treatment, the
 * fee is GST-inclusive and TrendStarZ absorbs it). Locked at acceptance.
 */
export function creatorFeeGstPercentFromSettings(settings: any): number {
  if (!settings?.platformFeeEnabled || !settings?.creatorFeeGstEnabled) return 0;
  return effectiveGstPercent(settings);
}

/**
 * The host's commission (%) for their role and plan, from raw app settings —
 * before any per-account override. Brand falls back to the global rate (10%
 * when unset); influencer / photographer hosts default to 0 until set.
 */
export function hostCommissionPercentFromSettings(
  settings: any,
  role: FeeRole,
  isPremium: boolean,
): number {
  const field =
    role === "photographer"
      ? "photographerFeePercent"
      : role === "influencer"
        ? "influencerFeePercent"
        : "brandFeePercent";
  const global = percentOrNull(settings?.platformFeePercent) ?? 10;
  const free = percentOrNull(settings?.[field]) ?? (role === "brand" ? global : 0);
  return rateForPlan(free, settings?.[PREMIUM_RATE_FIELDS[field]], isPremium);
}

/**
 * A per-account commission override set by admin (waiver / discount % off /
 * fixed %), applied while it's enabled and inside its validity window.
 */
export function applyCommissionOverride(
  percent: number,
  override: any,
  now: Date = new Date(),
): number {
  if (!override?.enabled) return percent;
  if (
    (override.validFrom && new Date(override.validFrom) > now) ||
    (override.validUntil && new Date(override.validUntil) < now)
  ) {
    return percent;
  }
  switch (override.overrideType) {
    case "waiver":
      return 0;
    case "discount":
      // e.g. 40 = 40% off the rate
      return Math.max(0, percent - (percent * Number(override.value || 0)) / 100);
    case "fixed":
      return Math.max(0, Number(override.value || 0));
    default:
      return percent;
  }
}

/**
 * The GST % that applies to one invite's creator fee: the rate locked at
 * acceptance; 0 for invites accepted before this existed (they were promised a
 * payout without it); otherwise today's setting (not accepted yet).
 */
export function creatorFeeGstPercentForInvite(invite: any, currentPercent: number): number {
  if (typeof invite?.recipientFeeGstPercent === "number") return invite.recipientFeeGstPercent;
  if (typeof invite?.recipientFeePercent === "number") return 0;
  return Number(currentPercent || 0);
}

/**
 * The creator side of a paid collaboration, in paise — one rule for the
 * invite preview, the checkout, the stored payment rows and the integrity check:
 *   fee = amount × fee%;  gst = fee × gst%;  payout = amount − fee − gst
 */
export function creatorPayoutBreakdown(
  agreedPaise: number,
  feePercent: number,
  gstPercent: number,
): { fee: number; gst: number; payout: number } {
  const amount = Math.max(Math.round(Number(agreedPaise || 0)), 0);
  const pct = Number(feePercent || 0);
  const fee = pct > 0 ? Math.round((amount * pct) / 100) : 0;
  const gstPct = Number(gstPercent || 0);
  const gst = fee > 0 && gstPct > 0 ? Math.round((fee * gstPct) / 100) : 0;
  return { fee, gst, payout: Math.max(amount - fee - gst, 0) };
}

/** GSTIN format: 2-digit state code + PAN (10) + entity no. + "Z" + check char. */
const GSTIN_PATTERN = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

export function normalizeGstin(value: unknown): string {
  return String(value ?? "").trim().toUpperCase();
}

const GSTIN_CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";

/** The 15th GSTIN character, computed from the first 14 (GSTN's mod-36 check). */
export function gstinCheckChar(first14: string): string {
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const product = GSTIN_CHARS.indexOf(first14[i]) * (i % 2 === 0 ? 1 : 2);
    sum += Math.floor(product / 36) + (product % 36);
  }
  return GSTIN_CHARS[(36 - (sum % 36)) % 36];
}

/** Format AND check character — so a mistyped GSTIN is refused, not saved. */
export function isValidGstin(value: unknown): boolean {
  const g = normalizeGstin(value);
  return GSTIN_PATTERN.test(g) && gstinCheckChar(g.slice(0, 14)) === g[14];
}

/**
 * The GST % TrendStarZ may actually charge: the configured rate only once a
 * valid GSTIN is saved in Settings — an unregistered business must not collect
 * GST. Every GST calculation goes through this, so even a GST rate written
 * straight into the database is never charged without a GSTIN.
 */
export function effectiveGstPercent(settings: any): number {
  if (!isValidGstin(settings?.gstin)) return 0;
  return percentOrNull(settings?.gstPercent) ?? 0;
}
