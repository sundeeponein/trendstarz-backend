import { MINIMUM_RATE_RUPEES } from "../utils/social-account.util";
import { TierDefinition, resolveTier, tierForFollowers } from "../utils/tier-ranges.util";

/**
 * The "Suggested ₹… — Use" rate hint on a creator's own profile (guidance
 * only; never saved or applied by itself). One Reel/Shorts rate per follower
 * tier; Video = ×1.8, Story = ×0.4, never below the ₹50 minimum rate.
 * Starter/Nano set by the user 2026-11-15 (were ₹500 for everyone ≤1,000).
 */
export const REEL_RATE_BY_TIER: Record<string, number> = {
  starter: 100, // 1–100 followers
  nano: 300, // 101–1,000
  micro: 1500, // 1,001–10,000
  mid_tier: 5000, // 10,001–1 lakh
  macro: 20000, // up to 10 lakh
  mega: 75000,
};

export interface RateSuggestion {
  reelPrice: number;
  storyPrice: number;
  videoPrice: number;
}

export function ratesForTier(tier: TierDefinition | null): RateSuggestion | null {
  const reel = tier ? REEL_RATE_BY_TIER[tier.key] : undefined;
  if (!reel) return null;
  return {
    reelPrice: reel,
    storyPrice: Math.max(MINIMUM_RATE_RUPEES, Math.round(reel * 0.4)),
    videoPrice: Math.round(reel * 1.8),
  };
}

export function ratesForFollowers(followers: unknown): RateSuggestion | null {
  return ratesForTier(tierForFollowers(followers));
}

/** Platform name → lowercase key used by the profile form ("YouTube" → "youtube"). */
const platformKey = (name: unknown) => String(name ?? "").trim().toLowerCase();

/**
 * Suggestions per platform from the tier the creator's profile shows for that
 * platform (the tier the admin verifies), so a big Instagram never inflates a
 * small YouTube. Accounts without a readable tier are left out.
 */
export function ratesByPlatformFromProfile(
  socialMedia: unknown,
): Record<string, RateSuggestion> {
  const out: Record<string, RateSuggestion> = {};
  for (const entry of Array.isArray(socialMedia) ? socialMedia : []) {
    const key = platformKey((entry as any)?.platform);
    const rates = ratesForTier(resolveTier((entry as any)?.tier));
    if (key && rates && !out[key]) out[key] = rates;
  }
  return out;
}
