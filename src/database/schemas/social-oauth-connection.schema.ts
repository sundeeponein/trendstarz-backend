import { Schema } from "mongoose";

export const SOCIAL_OAUTH_PLATFORMS = ["instagram", "facebook"] as const;

// One doc per user+platform — stores the Meta Graph API OAuth connection
// used by InstagramCollectorService/FacebookCollectorService to pull real
// data instead of the self-reported fallback. accessToken is select:false
// (basic protection, not encrypted — deliberate v1 scope, see
// meta-oauth.service.ts).
export const SocialOAuthConnectionSchema = new Schema(
  {
    userId: { type: Schema.Types.Mixed, required: true, index: true },
    userType: {
      type: String,
      enum: ["Influencer", "Brand", "Photographer"],
      required: true,
    },
    platform: { type: String, enum: SOCIAL_OAUTH_PLATFORMS, required: true },
    accessToken: { type: String, required: true, select: false },
    longLivedTokenExpiresAt: { type: Date, default: null },
    facebookPageId: { type: String, default: null },
    instagramBusinessAccountId: { type: String, default: null },
    // Display cache only — populated at connect time and refreshed on every
    // real collector run (see InstagramCollectorService/FacebookCollectorService),
    // never used for scoring itself (that always re-fetches live).
    handle: { type: String, default: null },
    followersCount: { type: Number, default: null },
    scopes: { type: [String], default: [] },
    connectedAt: { type: Date, default: Date.now },
    revokedAt: { type: Date, default: null },
    lastRefreshedAt: { type: Date, default: null },
  },
  { collection: "social_oauth_connections", timestamps: true },
);

SocialOAuthConnectionSchema.index({ userId: 1, platform: 1 }, { unique: true });
