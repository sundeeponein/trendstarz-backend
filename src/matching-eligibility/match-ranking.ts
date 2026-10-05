import {
  NormalizedCampaignMatchInput,
  NormalizedCreatorMatchInput,
} from "../matching-inputs/matching-inputs";
import {
  EligibilityResult,
  aggregateOverall,
  intersect,
  requiredCreatorCategories,
} from "./eligibility";

/**
 * Stage 3C-1 — deterministic match ranking (pure).
 *
 * Orders ONLY the creators whose Stage 3B-2 eligibility is PASS. FAIL and
 * UNKNOWN creators get no position. Ranking never changes eligibility.
 *
 * Lexicographic, no weights, no composite score, no randomness:
 *   1. platform/content coverage — matched campaign pairs / campaign pairs
 *   2. category coverage         — matched campaign categories / campaign categories
 *   3. activity bucket           — from creator.lastActiveAt (lastLoginAt, else lastOpenedAt)
 *   4. creatorId                 — ascending, final tie-break
 *
 * Coverage is always measured on the CAMPAIGN side (iterating the campaign's
 * own de-duplicated list), so extra creator pairs/categories never help and
 * the matched count can never exceed the campaign count. Comparison reuses the
 * Stage 3B `intersect` and canonical inputs — no second normalization.
 *
 * `asOf` is the only clock. No Date.now(), no DB, no TrendScore, no followers,
 * no tier, no verification, no pricing, no AI. Nothing is written.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

export type ActivityBucket =
  | "within_7_days"
  | "within_8_30_days"
  | "within_31_90_days"
  | "over_90_days"
  | "unknown";

/**
 * Ordering of activity buckets (lower ranks first). UNKNOWN is neutral: it
 * ties with the middle bucket (31–90 days) — never last, never rewarded above
 * a creator known to be recently active.
 */
export const ACTIVITY_BUCKET_ORDER: Record<ActivityBucket, number> = {
  within_7_days: 0,
  within_8_30_days: 1,
  within_31_90_days: 2,
  unknown: 2,
  over_90_days: 3,
};

export interface Coverage {
  /** Campaign values the creator matches (campaign spelling, campaign order). */
  matched: string[];
  /** Campaign values considered (0 = the campaign configures none → neutral). */
  total: number;
}

export interface RankedCreator {
  creatorId: string;
  /** 1-based position among PASS creators. */
  rank: number;
  platformContent: Coverage;
  category: Coverage;
  activity: {
    bucket: ActivityBucket;
    lastActiveAt: string | null;
    /** Whole days between lastActiveAt and asOf; null when unknown. */
    daysSinceActive: number | null;
  };
  rankingReasons: string[];
}

export interface RankingEntry {
  result: EligibilityResult;
  creator: NormalizedCreatorMatchInput;
}

function coverage(required: string[], creatorValues: string[]): Coverage {
  return {
    matched: intersect(required, creatorValues),
    total: required.length,
  };
}

/**
 * Bucket boundaries are inclusive upper bounds on elapsed time since the
 * activity timestamp: ≤ 7d, ≤ 30d, ≤ 90d, else > 90d. Missing, invalid or
 * future timestamps (later than asOf) are UNKNOWN.
 */
export function activityBucket(
  lastActiveAt: Date | null,
  asOf: Date,
): { bucket: ActivityBucket; daysSinceActive: number | null } {
  const t = lastActiveAt ? lastActiveAt.getTime() : NaN;
  const elapsed = asOf.getTime() - t;
  if (!Number.isFinite(elapsed) || elapsed < 0)
    return { bucket: "unknown", daysSinceActive: null };
  const daysSinceActive = Math.floor(elapsed / DAY_MS);
  if (elapsed <= 7 * DAY_MS)
    return { bucket: "within_7_days", daysSinceActive };
  if (elapsed <= 30 * DAY_MS)
    return { bucket: "within_8_30_days", daysSinceActive };
  if (elapsed <= 90 * DAY_MS)
    return { bucket: "within_31_90_days", daysSinceActive };
  return { bucket: "over_90_days", daysSinceActive };
}

function coverageReason(
  c: Coverage,
  noun: string,
  noneConfigured: string,
): string {
  if (!c.total) return noneConfigured;
  if (c.matched.length === c.total) return `Matches all campaign ${noun}`;
  return `Matches ${c.matched.length} of ${c.total} campaign ${noun}`;
}

const ACTIVITY_REASONS: Record<Exclude<ActivityBucket, "unknown">, string> = {
  within_7_days: "Active within the last 7 days",
  within_8_30_days: "Active within the last 8–30 days",
  within_31_90_days: "Active within the last 31–90 days",
  over_90_days: "Last active more than 90 days ago",
};

function activityReason(
  bucket: ActivityBucket,
  lastActiveAt: Date | null,
): string {
  if (bucket !== "unknown") return ACTIVITY_REASONS[bucket];
  const t = lastActiveAt ? lastActiveAt.getTime() : NaN;
  return Number.isFinite(t)
    ? "Recorded activity is later than the ranking time; treated as neutral."
    : "Recent activity is unavailable; treated as neutral.";
}

/** a/b vs c/d without floating point (b, d ≥ 0; x/0 is neutral and equals any other x/0). */
const compareCoverage = (a: Coverage, b: Coverage) =>
  b.matched.length * a.total - a.matched.length * b.total;

const compareIds = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export function rankEligibleCreators(
  campaign: NormalizedCampaignMatchInput,
  entries: RankingEntry[],
  asOf: Date,
): RankedCreator[] {
  if (!(asOf instanceof Date) || Number.isNaN(asOf.getTime()))
    throw new Error("rankEligibleCreators: asOf must be a valid Date");

  const seen = new Set<string>();
  const candidates: Omit<RankedCreator, "rank">[] = [];
  for (const { result, creator } of entries) {
    if (result.campaignId !== campaign.campaignId)
      throw new Error("rankEligibleCreators: result is for another campaign");
    if (result.creatorId !== creator.creatorId)
      throw new Error("rankEligibleCreators: result/creator mismatch");
    if (seen.has(creator.creatorId))
      throw new Error("rankEligibleCreators: duplicate creator");
    seen.add(creator.creatorId);
    // Same re-derivation as the admin row, so a row and its rank always agree.
    if (
      result.overall !== "PASS" ||
      aggregateOverall(Object.values(result.requirements)) !== "PASS"
    )
      continue;

    const platformContent = coverage(
      campaign.contentTypes,
      creator.contentTypes,
    );
    const category = coverage(
      requiredCreatorCategories(campaign),
      creator.categories,
    );
    const { bucket, daysSinceActive } = activityBucket(
      creator.lastActiveAt,
      asOf,
    );
    const lastActiveValid =
      creator.lastActiveAt && !Number.isNaN(creator.lastActiveAt.getTime());
    candidates.push({
      creatorId: creator.creatorId,
      platformContent,
      category,
      activity: {
        bucket,
        lastActiveAt: lastActiveValid
          ? creator.lastActiveAt!.toISOString()
          : null,
        daysSinceActive,
      },
      rankingReasons: [
        coverageReason(
          platformContent,
          "platform/content options",
          "Campaign has no platform/content options to compare; treated as neutral.",
        ),
        coverageReason(
          category,
          "categories",
          "Campaign has no category requirement; treated as neutral.",
        ),
        activityReason(bucket, creator.lastActiveAt),
      ],
    });
  }

  candidates.sort(
    (a, b) =>
      compareCoverage(a.platformContent, b.platformContent) ||
      compareCoverage(a.category, b.category) ||
      ACTIVITY_BUCKET_ORDER[a.activity.bucket] -
        ACTIVITY_BUCKET_ORDER[b.activity.bucket] ||
      compareIds(a.creatorId, b.creatorId),
  );
  return candidates.map((c, i) => ({ ...c, rank: i + 1 }));
}
