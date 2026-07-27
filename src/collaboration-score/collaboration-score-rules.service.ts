import { Injectable } from "@nestjs/common";
import { CollectedPlatformData } from "./collectors/collector.interface";

export type CollaborationScoreUserType = "Influencer" | "Brand" | "Photographer";

export interface AiAnalysisResult {
  captionQuality: { score: number; notes: string };
  brandSafety: { score: number; riskFlags: string[]; notes: string };
  contentCategory: { primary: string; secondary: string[]; confidence: number };
  visualBrandingNotes: string;
  postingToneConsistency: { score: number; notes: string };
  overallContentQualityScore: number;
  strengths: string[];
  improvements: string[];
}

export interface CollaborationScoreSettingsSnapshot {
  weights: {
    contentQuality: { rulesPercent: number; aiPercent: number };
    professionalBranding: { rulesPercent: number; aiPercent: number };
  };
  thresholds: {
    trendstarzRecommendedMinScore: number;
    campaignReadyMinScore: number;
    partiallyReadyMinScore: number;
  };
  // Top-level criteria weights for the overall collaborationScore — must sum
  // to 100 (enforced in CollaborationScoreSettingsService.buildUpdate()).
  // Defaults (15/25/20/20/20) match what was previously hardcoded here.
  scoreWeights: {
    profileCompletion: number;
    contentQuality: number;
    postingConsistency: number;
    professionalBranding: number;
    campaignReadiness: number;
  };
}

export interface ComputeScoresInput {
  profile: any;
  userType: CollaborationScoreUserType;
  completion: number; // from ProfileVerificationService.getCompletionSnapshot()
  flags: any[]; // open ProfileFlag docs, same source as completion
  eligibility: { eligible: boolean; blockers: string[] }; // from ProfileVerificationService.buildEligibility()
  collectedPlatforms: CollectedPlatformData[];
  settings: CollaborationScoreSettingsSnapshot;
  aiResult: AiAnalysisResult | null; // null when AI is off — see collaboration-score-ai.service.ts
}

export interface ComputedScores {
  profileCompletenessScore: number;
  contentQualityScore: number;
  postingConsistencyScore: number;
  professionalBrandingScore: number;
  campaignReadinessScore: number;
  collaborationScore: number;
  portfolioScore: number | null;
  campaignReadiness: "Campaign Ready" | "Partially Ready" | "Not Ready";
  trendstarzRecommended: boolean;
  trendstarzRecommendedMinScore: number;
  pricingSuggestion: {
    reelPrice: number | null;
    storyPrice: number | null;
    videoPrice: number | null;
    currency: string;
    basis: string;
  };
  categoryMatch: string[];
  strengths: string[];
  improvements: string[];
  recommendations: string[];
}

const PROFILE_PHOTO_ISSUE_CODES = new Set([
  "PROFILE_PHOTO_MISSING",
  "PROFILE_PHOTO_SCREENSHOT",
  "PROFILE_PHOTO_LOW_QUALITY",
  "PROFILE_PHOTO_BLURRY",
  "PROFILE_PHOTO_QUALITY",
]);

// Base per-tier reel rate (INR) for the pricing suggestion — a simple,
// transparent Phase-A approximation per the spec's "never estimate using AI
// only" rule. PHASE C TODO: replace with admin-configurable marketplace-rate
// rules (own settings, not hardcoded here) once real transaction-price data
// exists to calibrate against.
const TIER_BASE_REEL_RATE: Array<{ maxFollowers: number; rate: number }> = [
  { maxFollowers: 1000, rate: 500 },
  { maxFollowers: 10000, rate: 1500 },
  { maxFollowers: 100000, rate: 5000 },
  { maxFollowers: 1000000, rate: 20000 },
  { maxFollowers: Infinity, rate: 75000 },
];

/**
 * Pure scoring math — no I/O, no DB/HTTP access. Deliberately transparent
 * ("never a black box score" per spec): every sub-score is derived from a
 * named, inspectable input rather than an opaque model call. The only AI
 * input point is the pre-computed aiResult passed in.
 */
@Injectable()
export class CollaborationScoreRulesService {
  /**
   * Anonymous, pre-registration preview — only Content Quality (25%) and
   * Posting Consistency (20%) are computable with no registered profile, so
   * this re-normalizes just those two (25:20 -> 55:45) rather than faking the
   * other three criteria. Never used for the real, post-registration score.
   */
  computePreviewScores(
    collectedPlatforms: CollectedPlatformData[],
    settings: CollaborationScoreSettingsSnapshot,
  ): { contentQualityScore: number; postingConsistencyScore: number; previewScore: number } {
    const input: ComputeScoresInput = {
      profile: {},
      userType: "Influencer",
      completion: 0,
      flags: [],
      eligibility: { eligible: false, blockers: [] },
      collectedPlatforms,
      settings,
      aiResult: null,
    };
    // Fail-safe to 0 rather than propagating NaN — this endpoint is
    // anonymous and unauthenticated, fed by arbitrary public URLs and a
    // live third-party API response we don't control (e.g. an unusual
    // publishedAt value producing an Invalid Date somewhere upstream).
    // JSON.stringify(NaN) serializes as `null`, which Angular renders as
    // nothing — exactly the blank "/100" bug this guards against.
    const safe = (n: number) => (Number.isFinite(n) ? n : 0);
    const contentQualityScore = safe(this.computeContentQuality(input));
    const postingConsistencyScore = safe(this.computePostingConsistency(input));
    const previewScore = safe(Math.round(0.55 * contentQualityScore + 0.45 * postingConsistencyScore));
    return { contentQualityScore, postingConsistencyScore, previewScore };
  }

  computeScores(input: ComputeScoresInput): ComputedScores {
    const profileCompletenessScore = Math.round(
      Math.max(0, Math.min(100, input.completion)),
    );

    const contentQualityScore = this.computeContentQuality(input);
    const postingConsistencyScore = this.computePostingConsistency(input);
    const professionalBrandingScore = this.computeProfessionalBranding(input);
    const campaignReadinessScore = this.computeCampaignReadinessScore(input);

    const w = input.settings.scoreWeights;
    const collaborationScore = Math.round(
      (w.profileCompletion / 100) * profileCompletenessScore +
        (w.contentQuality / 100) * contentQualityScore +
        (w.postingConsistency / 100) * postingConsistencyScore +
        (w.professionalBranding / 100) * professionalBrandingScore +
        (w.campaignReadiness / 100) * campaignReadinessScore,
    );

    const campaignReadiness = this.campaignReadinessLabel(
      collaborationScore,
      input.settings,
    );
    const trendstarzRecommended =
      collaborationScore >= input.settings.thresholds.trendstarzRecommendedMinScore &&
      campaignReadiness === "Campaign Ready";

    const portfolioScore =
      input.userType === "Photographer" ? this.computePortfolioScore(input) : null;

    const { strengths, improvements, recommendations } = this.buildNarrative(input, {
      profileCompletenessScore,
      contentQualityScore,
      postingConsistencyScore,
      professionalBrandingScore,
      campaignReadinessScore,
    });

    return {
      profileCompletenessScore,
      contentQualityScore,
      postingConsistencyScore,
      professionalBrandingScore,
      campaignReadinessScore,
      collaborationScore,
      portfolioScore,
      campaignReadiness,
      trendstarzRecommended,
      trendstarzRecommendedMinScore: input.settings.thresholds.trendstarzRecommendedMinScore,
      pricingSuggestion: this.computePricingSuggestion(input),
      categoryMatch: this.categoryMatch(input),
      strengths,
      improvements,
      recommendations,
    };
  }

  private campaignReadinessLabel(
    score: number,
    settings: CollaborationScoreSettingsSnapshot,
  ): "Campaign Ready" | "Partially Ready" | "Not Ready" {
    if (score >= settings.thresholds.campaignReadyMinScore) return "Campaign Ready";
    if (score >= settings.thresholds.partiallyReadyMinScore) return "Partially Ready";
    return "Not Ready";
  }

  /**
   * Confidence-weighted average across collected platforms — a platform with
   * 0 confidence (e.g. self-reported with no data at all) is excluded
   * entirely rather than dragging the score toward its placeholder value;
   * higher-confidence platforms (verified API data) outweigh low-confidence
   * ones (self-reported/Beta). Prevents overconfidence in sparse data.
   */
  private confidenceWeightedAverage(
    platforms: CollectedPlatformData[],
    scoreFn: (platform: CollectedPlatformData) => number,
  ): number {
    const weighted = platforms
      .map((platform) => ({ score: scoreFn(platform), weight: Math.max(0, platform.confidence || 0) }))
      .filter((entry) => entry.weight > 0);
    if (!weighted.length) return 0;
    const totalWeight = weighted.reduce((sum, entry) => sum + entry.weight, 0);
    return Math.round(
      weighted.reduce((sum, entry) => sum + entry.score * entry.weight, 0) / totalWeight,
    );
  }

  // ── Content Quality (25%) ──────────────────────────────────────────────
  private computeContentQuality(input: ComputeScoresInput): number {
    const rulesScore = this.confidenceWeightedAverage(input.collectedPlatforms, (platform) =>
      this.contentQualityForPlatform(platform),
    );

    const { rulesPercent, aiPercent } = this.effectiveWeights(
      input.settings.weights.contentQuality,
      input.aiResult,
    );
    const aiScore = input.aiResult?.overallContentQualityScore ?? 0;
    return Math.round((rulesScore * rulesPercent + aiScore * aiPercent) / 100);
  }

  private contentQualityForPlatform(platform: CollectedPlatformData): number {
    if (platform.method === "SELF_REPORTED") {
      // Unverified ceiling — self-reported data isn't independently verified.
      const stats = platform.raw as any;
      const complete = stats?.avgLikes != null && stats?.avgComments != null;
      return complete ? 50 : 20;
    }
    if (!platform.recentPosts.length) return 0;
    const withViews = platform.recentPosts.filter((p) => (p.views || 0) > 0);
    if (!withViews.length) return 30; // has posts, but no view data to rate engagement
    const avgEngagementRate =
      withViews.reduce(
        (sum, p) => sum + ((p.likes || 0) + (p.comments || 0)) / (p.views || 1),
        0,
      ) / withViews.length;
    if (avgEngagementRate >= 0.08) return 100;
    if (avgEngagementRate >= 0.04) return 80;
    if (avgEngagementRate >= 0.02) return 60;
    if (avgEngagementRate >= 0.01) return 40;
    return 20;
  }

  // ── Posting Consistency (20%) ──────────────────────────────────────────
  private computePostingConsistency(input: ComputeScoresInput): number {
    const rulesScore = this.confidenceWeightedAverage(input.collectedPlatforms, (platform) =>
      this.postingConsistencyForPlatform(platform),
    );

    // AI tone consistency is a minor modifier only, per spec — never the
    // primary driver of this criterion.
    const toneScore = input.aiResult?.postingToneConsistency?.score;
    if (toneScore == null) return rulesScore;
    return Math.round(rulesScore * 0.85 + toneScore * 0.15);
  }

  private postingConsistencyForPlatform(platform: CollectedPlatformData): number {
    if (platform.method === "SELF_REPORTED") return 50; // flat capped, unverified
    const posts = [...platform.recentPosts].sort(
      (a, b) => b.publishedAt.getTime() - a.publishedAt.getTime(),
    );
    if (!posts.length) return 0;

    const daysSinceLastPost =
      (Date.now() - posts[0].publishedAt.getTime()) / (1000 * 60 * 60 * 24);
    if (daysSinceLastPost > 60) return 10; // inactivity penalty

    if (posts.length < 2) return 50;
    const gapsDays: number[] = [];
    for (let i = 0; i < posts.length - 1; i++) {
      gapsDays.push(
        (posts[i].publishedAt.getTime() - posts[i + 1].publishedAt.getTime()) /
          (1000 * 60 * 60 * 24),
      );
    }
    const mean = gapsDays.reduce((a, b) => a + b, 0) / gapsDays.length;
    const variance =
      gapsDays.reduce((a, b) => a + (b - mean) ** 2, 0) / gapsDays.length;
    const stddev = Math.sqrt(variance);
    // Lower stddev (more even cadence) → higher score.
    if (stddev <= 3) return 100;
    if (stddev <= 7) return 80;
    if (stddev <= 14) return 60;
    if (stddev <= 30) return 40;
    return 20;
  }

  // ── Professional Branding (20%) ────────────────────────────────────────
  // Rules-only for now: the AI JSON schema's `visualBrandingNotes` is
  // free-text (text-only analysis, no vision), not a structured score — it's
  // surfaced as narrative in strengths/improvements below rather than faked
  // into a number, per "never a black box score."
  private computeProfessionalBranding(input: ComputeScoresInput): number {
    const { profile, userType, flags } = input;
    let score = 0;
    let maxScore = 0;

    maxScore += 30;
    const hasPhotoIssue = flags.some(
      (f) => f?.status === "Open" && PROFILE_PHOTO_ISSUE_CODES.has(String(f?.flagCode)),
    );
    const hasAnyPhoto =
      (Array.isArray(profile?.profileImages) && profile.profileImages.length > 0) ||
      !!profile?.profileImage ||
      (Array.isArray(profile?.brandLogo) && profile.brandLogo.length > 0);
    if (hasAnyPhoto && !hasPhotoIssue) score += 30;
    else if (hasAnyPhoto) score += 10;

    maxScore += 20;
    const bioText = String(
      profile?.description || profile?.expertiseArea || profile?.professionalStatus || "",
    ).trim();
    if (bioText.length >= 80) score += 20;
    else if (bioText.length >= 30) score += 10;

    maxScore += 20;
    const categoriesPopulated =
      (Array.isArray(profile?.categories) && profile.categories.length > 0) ||
      !!profile?.influencerCategory ||
      (Array.isArray(profile?.skills) && profile.skills.length > 0);
    if (categoriesPopulated) score += 20;

    maxScore += 20;
    const pricingList: any[] =
      userType === "Photographer" ? profile?.pricing || [] : profile?.socialMedia?.[0]?.contentTypes || [];
    const pricingFilled = pricingList.some((p) => p?.enabled && Number(p?.price) > 0);
    if (pricingFilled) score += 20;

    if (userType === "Photographer") {
      maxScore += 10;
      if (Array.isArray(profile?.portfolio) ? profile.portfolio.length > 0 : !!profile?.portfolio) {
        score += 10;
      }
    }

    // Small informational bonus for existing admin verification — read-only,
    // never written by this module.
    if (profile?.verifiedByTrendStarz === true) {
      score += 5;
      maxScore += 5;
    }

    return Math.round((score / Math.max(1, maxScore)) * 100);
  }

  // ── Campaign Readiness (20%) — fully deterministic, no AI ──────────────
  private computeCampaignReadinessScore(input: ComputeScoresInput): number {
    const { eligibility, profile, flags } = input;
    if (eligibility.eligible) {
      const openHighFlags = flags.filter(
        (f) => f?.status === "Open" && f?.severity === "High",
      ).length;
      return Math.max(0, 100 - openHighFlags * 15);
    }
    const blockerPenalty = eligibility.blockers.length * 20;
    const hasPayout =
      !!profile?.payout?.upiId ||
      (!!profile?.payout?.mobile && !!profile?.payout?.accountHolderName);
    const payoutPenalty = hasPayout ? 0 : 15;
    return Math.max(0, 80 - blockerPenalty - payoutPenalty);
  }

  private computePortfolioScore(input: ComputeScoresInput): number {
    const { profile } = input;
    let score = 0;
    const portfolioUrls = Array.isArray(profile?.portfolio)
      ? profile.portfolio
      : profile?.portfolio
        ? [profile.portfolio]
        : [];
    if (portfolioUrls.length > 0) score += 50;
    if (Array.isArray(profile?.skills) && profile.skills.length >= 2) score += 25;
    if (Array.isArray(profile?.equipment) && profile.equipment.length >= 1) score += 25;
    return Math.min(100, score);
  }

  private computePricingSuggestion(input: ComputeScoresInput) {
    const followers = Math.max(
      0,
      ...input.collectedPlatforms.map((p) => p.followersOrSubscribers || 0),
      0,
    );
    const tierRate =
      TIER_BASE_REEL_RATE.find((t) => followers <= t.maxFollowers)?.rate ??
      TIER_BASE_REEL_RATE[TIER_BASE_REEL_RATE.length - 1].rate;

    return {
      reelPrice: tierRate,
      storyPrice: Math.round(tierRate * 0.4),
      videoPrice: Math.round(tierRate * 1.8),
      currency: "INR",
      basis: "Follower tier (Phase A approximation — see PHASE C TODO in this file)",
    };
  }

  private categoryMatch(input: ComputeScoresInput): string[] {
    const { profile, userType } = input;
    if (userType === "Photographer") return profile?.skills || [];
    const categories: string[] = Array.isArray(profile?.categories) ? profile.categories : [];
    const primary = profile?.influencerCategory ? [profile.influencerCategory] : [];
    return Array.from(new Set([...primary, ...categories]));
  }

  private effectiveWeights(
    weights: { rulesPercent: number; aiPercent: number },
    aiResult: AiAnalysisResult | null,
  ): { rulesPercent: number; aiPercent: number } {
    if (!aiResult) return { rulesPercent: 100, aiPercent: 0 };
    return weights;
  }

  private buildNarrative(
    input: ComputeScoresInput,
    scores: {
      profileCompletenessScore: number;
      contentQualityScore: number;
      postingConsistencyScore: number;
      professionalBrandingScore: number;
      campaignReadinessScore: number;
    },
  ): { strengths: string[]; improvements: string[]; recommendations: string[] } {
    const strengths: string[] = [];
    const improvements: string[] = [];
    const recommendations: string[] = [];

    if (scores.profileCompletenessScore >= 80) strengths.push("Profile is well filled out.");
    else improvements.push("Complete your profile — photo, bio, location, and payout details.");

    if (scores.contentQualityScore >= 70) strengths.push("Content shows strong engagement.");
    else improvements.push("Focus on content that drives more likes/comments relative to views.");

    if (scores.postingConsistencyScore < 40) {
      improvements.push("Post more consistently — long gaps between posts hurt this score.");
      recommendations.push("Aim for a steady posting cadence rather than bursts.");
    }

    if (scores.professionalBrandingScore < 60) {
      improvements.push("Fill in your bio, categories, and pricing to look more professional to brands.");
    }

    if (scores.campaignReadinessScore < 70) {
      recommendations.push(...input.eligibility.blockers);
    }

    if (input.aiResult) {
      strengths.push(...input.aiResult.strengths);
      improvements.push(...input.aiResult.improvements);
      if (input.aiResult.visualBrandingNotes) {
        improvements.push(input.aiResult.visualBrandingNotes);
      }
    }

    return { strengths, improvements, recommendations };
  }
}
