import { Schema } from "mongoose";

// Singleton doc (queried via findOne({}), same convention as AppSettingsSchema
// in profile.schemas.ts) — kept in its own collection rather than folded into
// AppSettings, since this feature needs nested weight/threshold objects and
// its own settings lifecycle (GET/PUT /api/audit/settings), distinct from
// AppSettings' huge flat scalar list.
export const CollaborationScoreSettingsSchema = new Schema(
  {
    // Cost safety valve — no LLM call is ever made while this is false.
    aiEnabled: { type: Boolean, default: false },
    aiModel: { type: String, default: "claude-sonnet-5" },

    // How much of the Content Quality / Professional Branding sub-scores
    // comes from rules vs AI. Redistributed 100% to rules when aiEnabled is
    // false — see CollaborationScoreRulesService.
    weights: {
      contentQuality: {
        rulesPercent: { type: Number, default: 60 },
        aiPercent: { type: Number, default: 40 },
      },
      professionalBranding: {
        rulesPercent: { type: Number, default: 70 },
        aiPercent: { type: Number, default: 30 },
      },
    },

    thresholds: {
      trendstarzRecommendedMinScore: { type: Number, default: 80 },
      campaignReadyMinScore: { type: Number, default: 70 },
      partiallyReadyMinScore: { type: Number, default: 40 },
    },

    // Platform-wide rollout switch — NOT tied to isPremium (that's a
    // subscription concept; see the Version 1 vs Version 2 section of the
    // Collaboration Score plan). Gates AI-enhanced scoring, pricing
    // suggestions, and nightly re-audits.
    version2Enabled: { type: Boolean, default: false },

    // Per-platform collector kill-switch — lets admin disable a platform
    // (e.g. while its collector is unreliable) without a code deploy.
    platformsEnabled: {
      instagram: { type: Boolean, default: true },
      youtube: { type: Boolean, default: true },
      facebook: { type: Boolean, default: true },
      linkedin: { type: Boolean, default: true },
    },

    // Cooldown-only re-analysis limit — enforced in CollaborationScoreService.
    // reanalysisFeeRupees is stored/displayed for future use; no payment
    // collection is wired yet (cooldown enforcement only, by design).
    reanalysisCooldownDays: { type: Number, default: 30 },
    reanalysisFeeRupees: { type: Number, default: 99 },

    nightlyReauditEnabled: { type: Boolean, default: false },
    nightlyReauditCronHour: { type: Number, default: 2 },
    youtubeApiQuotaGuardPerDay: { type: Number, default: 8000 },

    lastNightlyRunAt: { type: Date, default: null },
    lastNightlyRunCount: { type: Number, default: 0 },
    lastNightlyRunCostUsd: { type: Number, default: 0 },
  },
  { collection: "collaboration_score_settings", timestamps: true },
);
