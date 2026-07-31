import { Schema } from "mongoose";

export const COLLABORATION_AUDIT_USER_TYPES = [
  "Influencer",
  "Brand",
  "Photographer",
] as const;

export const COLLABORATION_AUDIT_PLATFORMS = [
  "YouTube",
  "Instagram",
  "Facebook",
  "LinkedIn",
] as const;

export const COLLABORATION_AUDIT_COLLECTION_METHODS = [
  "API",
  "SELF_REPORTED",
] as const;

export const COLLABORATION_AUDIT_CAMPAIGN_READINESS = [
  "Campaign Ready",
  "Partially Ready",
  "Not Ready",
] as const;

export const COLLABORATION_AUDIT_TRIGGERS = [
  "USER",
  "ADMIN",
  "SYSTEM_NIGHTLY",
  // Fired once, automatically, the first time a creator connects a given
  // platform (Instagram/Facebook OAuth) — see
  // CollaborationScoreService.handleOAuthCallback. Never fired on a
  // reconnect of an already-connected platform.
  "SYSTEM_CONNECT",
] as const;

export const COLLABORATION_AUDIT_STATUSES = [
  "completed",
  "failed",
  "pending",
] as const;

const ScoreNoteSchema = new Schema(
  { score: { type: Number, default: 0 }, notes: { type: String, default: "" } },
  { _id: false },
);

// AI-derived analysis, text-only at launch. Persisted null when the admin
// AI toggle is off — see collaboration-score-settings.schema.ts:aiEnabled.
const AiAnalysisSchema = new Schema(
  {
    captionQuality: { type: ScoreNoteSchema, default: () => ({}) },
    brandSafety: {
      score: { type: Number, default: 0 },
      riskFlags: { type: [String], default: [] },
      notes: { type: String, default: "" },
    },
    contentCategory: {
      primary: { type: String, default: "" },
      secondary: { type: [String], default: [] },
      confidence: { type: Number, default: 0 },
    },
    visualBrandingNotes: { type: String, default: "" },
    postingToneConsistency: { type: ScoreNoteSchema, default: () => ({}) },
    overallContentQualityScore: { type: Number, default: 0 },
    strengths: { type: [String], default: [] },
    improvements: { type: [String], default: [] },
  },
  { _id: false },
);

export const CollaborationAuditSchema = new Schema(
  {
    userId: { type: Schema.Types.Mixed, required: true, index: true },
    userType: {
      type: String,
      enum: COLLABORATION_AUDIT_USER_TYPES,
      required: true,
      index: true,
    },
    version: { type: Number, required: true },
    isCurrent: { type: Boolean, default: true, index: true },

    platformsCollected: [
      {
        platform: { type: String, enum: COLLABORATION_AUDIT_PLATFORMS, required: true },
        method: { type: String, enum: COLLABORATION_AUDIT_COLLECTION_METHODS, required: true },
        handle: { type: String, default: "" },
        collectedAt: { type: Date, default: Date.now },
        raw: { type: Schema.Types.Mixed, default: null },
        // Transparency: never let a sparse/unverified platform imply more
        // confidence than the data supports. See collector.interface.ts.
        confidence: { type: Number, default: 0 },
        confidenceReason: { type: String, default: "" },
        // This platform's own Content Quality + Posting Consistency in
        // isolation (renormalized to 0-100) — see
        // CollaborationScoreRulesService.platformMiniScore. Shown in
        // Platform Status alongside, never instead of, collaborationScore.
        miniScore: { type: Number, default: 0 },
        _id: false,
      },
    ],

    // Weighted sub-scores (0-100). Fixed platform weights (not admin-editable):
    // 15 / 25 / 20 / 20 / 20 — see collaboration-score-rules.service.ts.
    profileCompletenessScore: { type: Number, default: 0 },
    contentQualityScore: { type: Number, default: 0 },
    postingConsistencyScore: { type: Number, default: 0 },
    professionalBrandingScore: { type: Number, default: 0 },
    campaignReadinessScore: { type: Number, default: 0 },
    collaborationScore: { type: Number, default: 0, index: true },

    // Photographer/Videographer only — shown alongside the 5 weighted
    // criteria, never folded into collaborationScore. Null for other roles.
    portfolioScore: { type: Number, default: null },

    campaignReadiness: {
      type: String,
      enum: COLLABORATION_AUDIT_CAMPAIGN_READINESS,
      default: "Not Ready",
    },
    trendstarzRecommended: { type: Boolean, default: false, index: true },
    // Threshold snapshot at compute time — lets the dashboard show a
    // "Need +N points" gap without exposing admin-only settings to creators.
    trendstarzRecommendedMinScore: { type: Number, default: 80 },
    pricingSuggestion: {
      reelPrice: { type: Number, default: null },
      storyPrice: { type: Number, default: null },
      videoPrice: { type: Number, default: null },
      currency: { type: String, default: "INR" },
      basis: { type: String, default: "" },
    },
    categoryMatch: { type: [String], default: [] },

    aiAnalysis: { type: AiAnalysisSchema, default: null },
    aiUsed: { type: Boolean, default: false },
    aiModel: { type: String, default: null },
    aiCallType: { type: String, enum: ["sync", "batch", null], default: null },
    aiInputTokens: { type: Number, default: 0 },
    aiOutputTokens: { type: Number, default: 0 },
    aiCostUsd: { type: Number, default: 0 },

    // Merged rules+AI, brand-safe view is built from these three at read time
    // — see CollaborationScoreService's brand-facing projection.
    strengths: { type: [String], default: [] },
    improvements: { type: [String], default: [] },
    recommendations: { type: [String], default: [] },

    status: { type: String, enum: COLLABORATION_AUDIT_STATUSES, default: "completed", index: true },
    failureReason: { type: String, default: "" },
    triggeredBy: { type: String, enum: COLLABORATION_AUDIT_TRIGGERS, default: "USER" },
    // True only for a re-analysis that completed a paid Razorpay flow — see
    // CollaborationScoreService.verifyReanalysisPayment. Every other run
    // (first-ever free audit, nightly system re-audit, admin trigger)
    // defaults false, which is correct since none of those are paid.
    isPaid: { type: Boolean, default: false },
    runId: { type: String, default: "", index: true },
    durationMs: { type: Number, default: 0 },
  },
  { collection: "collaboration_audits", timestamps: true },
);

CollaborationAuditSchema.index({ userId: 1, isCurrent: 1 });
// unique: closes the race window where two concurrent runAudit() calls for
// the same user (double-click, refresh-and-retry, two tabs) both read the
// same previousCurrent.version and try to create the same next version —
// the second insert now fails fast with a duplicate-key error instead of
// silently creating two "current" audits. See runAudit()'s catch block.
CollaborationAuditSchema.index({ userId: 1, version: -1 }, { unique: true });
CollaborationAuditSchema.index({ trendstarzRecommended: 1, isCurrent: 1 });
