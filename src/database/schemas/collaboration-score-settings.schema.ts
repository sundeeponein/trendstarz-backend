import { Schema } from "mongoose";

// Bump this and branch on doc.schemaVersion inside normalize() the day a
// real migration is needed (e.g. a field changes shape). No migration logic
// exists yet — there's nothing to migrate from at version 1.
export const CURRENT_AUDIT_SETTINGS_SCHEMA_VERSION = 1;

// Singleton doc (queried via findOne({}), same convention as AppSettingsSchema
// in profile.schemas.ts) — kept in its own collection rather than folded into
// AppSettings, since this feature needs nested weight/threshold objects and
// its own settings lifecycle (GET/PUT /api/audit/settings), distinct from
// AppSettings' huge flat scalar list.
//
// strict: false — future settings fields (added to
// collaboration-score-settings.default.json without a matching schema/DTO
// change) are still persisted instead of being silently stripped by
// Mongoose on write. Known fields are still declared below for defaults,
// type coercion, and self-documentation.
export const CollaborationScoreSettingsSchema = new Schema(
  {
    schemaVersion: { type: Number, default: CURRENT_AUDIT_SETTINGS_SCHEMA_VERSION },

    // Cost safety valve — no LLM call is ever made while this is false.
    aiEnabled: { type: Boolean, default: false },
    aiModel: { type: String, default: "claude-sonnet-5" },

    // Kill-switch for the anonymous, pre-registration YouTube preview.
    anonymousPreviewEnabled: { type: Boolean, default: true },
    // How many audits (ever) are free before an account must pay to re-analyze.
    freeAuditCount: { type: Number, default: 1 },
    // Stored for future use — nothing currently treats an audit as "stale".
    auditValidityDays: { type: Number, default: 365 },

    // How much of the Content Quality / Professional Branding sub-scores
    // comes from rules vs AI. Redistributed 100% to rules when aiEnabled is
    // false — see CollaborationScoreRulesService. Each pair must sum to 100
    // (enforced in CollaborationScoreSettingsService.buildUpdate()).
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

    // Top-level criteria weights for the overall collaborationScore formula
    // — must sum to 100 (enforced in buildUpdate()). Defaults match the
    // formula that was previously hardcoded in CollaborationScoreRulesService.
    scoreWeights: {
      profileCompletion: { type: Number, default: 15 },
      contentQuality: { type: Number, default: 25 },
      postingConsistency: { type: Number, default: 20 },
      professionalBranding: { type: Number, default: 20 },
      campaignReadiness: { type: Number, default: 20 },
    },

    // Platform-wide rollout switch — NOT tied to isPremium (that's a
    // subscription concept; see the Version 1 vs Version 2 section of the
    // Collaboration Score plan). Gates AI-enhanced scoring, pricing
    // suggestions, and nightly re-audits.
    version2Enabled: { type: Boolean, default: false },
    version1Name: { type: String, default: "Collaboration Score" },
    version2Name: { type: String, default: "Marketplace Insights" },

    // Per-platform collector kill-switch — lets admin disable a platform
    // (e.g. while its collector is unreliable) without a code deploy.
    platformsEnabled: {
      instagram: { type: Boolean, default: true },
      youtube: { type: Boolean, default: true },
      facebook: { type: Boolean, default: true },
      linkedin: { type: Boolean, default: true },
    },

    // Hard-floor cooldown, unaffected by payment — see
    // CollaborationScoreService.assertCooldownElapsed. First freeAuditCount
    // audits are free; every one after requires a captured payment at
    // reanalysisFeeRupees — see assertFreeAuditAvailable/createReanalysisOrder.
    reanalysisCooldownDays: { type: Number, default: 30 },
    reanalysisFeeRupees: { type: Number, default: 49 },

    nightlyReauditEnabled: { type: Boolean, default: false },
    nightlyReauditCronHour: { type: Number, default: 2 },
    youtubeApiQuotaGuardPerDay: { type: Number, default: 8000 },

    // Only trackAuditCost is currently wired (gates the cost fields in
    // adminList's summary/todaySummary) — see CollaborationScoreService.
    analytics: {
      trackAuditCost: { type: Boolean, default: true },
      trackAverageScore: { type: Boolean, default: true },
      trackPlatformUsage: { type: Boolean, default: true },
      trackAuditHistory: { type: Boolean, default: true },
    },

    lastNightlyRunAt: { type: Date, default: null },
    lastNightlyRunCount: { type: Number, default: 0 },
    lastNightlyRunCostUsd: { type: Number, default: 0 },
  },
  { collection: "collaboration_score_settings", timestamps: true, strict: false },
);
