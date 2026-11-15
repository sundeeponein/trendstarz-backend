import { MINIMUM_RATE_RUPEES } from "../utils/social-account.util";
import {
  CANONICAL_TIERS,
  TierDefinition,
  resolveTier,
  tierForFollowers,
} from "../utils/tier-ranges.util";

/**
 * Usual rate range per follower tier (guidance only; never saved or applied by
 * itself). Decided by the user 2026-11-15: a range instead of one exact figure,
 * Reel/Shorts below; Video ×1.8, Story ×0.4 (never under the ₹50 minimum).
 * max null = open-ended ("₹40,000+").
 *
 * Used by: the creator profile hint ("Usual range for your tier"), and the
 * price-change rule — a raise or new rate above the range waits for admin
 * approval; within it applies straight away (price-changes.util).
 */
export const REEL_RANGE_BY_TIER: Record<string, { min: number; max: number | null }> = {
  starter: { min: 50, max: 150 }, // 1–100 followers
  nano: { min: 150, max: 500 }, // 101–1,000
  micro: { min: 500, max: 3000 }, // 1,001–10,000
  mid_tier: { min: 3000, max: 10000 }, // 10,001–1 lakh
  macro: { min: 10000, max: 40000 }, // up to 10 lakh
  mega: { min: 40000, max: null },
};

export interface RateRange {
  min: number;
  max: number | null;
}
export interface TierRateRanges {
  reel: RateRange;
  video: RateRange;
  story: RateRange;
}

const scale = (r: RateRange, factor: number): RateRange => ({
  min: Math.max(MINIMUM_RATE_RUPEES, Math.round(r.min * factor)),
  max: r.max === null ? null : Math.max(MINIMUM_RATE_RUPEES, Math.round(r.max * factor)),
});

export function rangesForTier(tier: TierDefinition | null): TierRateRanges | null {
  const reel = tier ? REEL_RANGE_BY_TIER[tier.key] : undefined;
  if (!reel) return null;
  return { reel: { ...reel }, video: scale(reel, 1.8), story: scale(reel, 0.4) };
}

/** Which range a rate row uses, by its content-type name (same mapping as the profile hint). */
export function rangeKindFor(contentTypeName: unknown): keyof TierRateRanges | null {
  const name = String(contentTypeName ?? "").toLowerCase();
  if (name.includes("story")) return "story";
  if (name.includes("reel") || name.includes("short")) return "reel";
  if (name.includes("video")) return "video";
  return null;
}

/**
 * The usual range's top for this tier and rate: { top } (null = open-ended,
 * e.g. Mega), or null when the rate has no range (Photo post…) or the tier is
 * unknown.
 */
export function rangeFor(tier: unknown, contentTypeName: unknown): { top: number | null } | null {
  const ranges = rangesForTier(resolveTier(tier));
  const kind = rangeKindFor(contentTypeName);
  return ranges && kind ? { top: ranges[kind].max } : null;
}

/** The whole table, keyed by the tier name the profile dropdown stores ("Starter" … "Mega / Celebrity"). */
export function rateRangeTable(): Record<string, TierRateRanges> {
  const out: Record<string, TierRateRanges> = {};
  for (const t of CANONICAL_TIERS) {
    const r = rangesForTier(t);
    if (r) out[t.label] = r;
  }
  return out;
}

// ── Stored TrendScore audits still carry one number (not shown on the profile any more) ──

export interface RateSuggestion {
  reelPrice: number;
  storyPrice: number;
  videoPrice: number;
}

/** Bottom of the usual range for the follower count — the value stored on TrendScore audits. */
export function ratesForFollowers(followers: unknown): RateSuggestion | null {
  const r = rangesForTier(tierForFollowers(followers));
  return r ? { reelPrice: r.reel.min, storyPrice: r.story.min, videoPrice: r.video.min } : null;
}
