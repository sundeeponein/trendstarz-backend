import { Schema } from "mongoose";
import { SOCIAL_PROFILE_TYPES } from "./social-account-verification.schema";

/**
 * Stage 3A-2 — what an external platform reported about a social account.
 *
 * OBSERVED data only. Kept apart from DECLARED data (profile.socialMedia[],
 * which observation never writes — not even followersCount) and from VERIFIED
 * data (social_account_verifications / social_account_reviews, which
 * observation never reads or writes). Never holds tokens or raw API responses.
 */
export const OBSERVATION_SOURCES = [
  "youtube",
  "instagram",
  "facebook",
] as const;
export type ObservationSource = (typeof OBSERVATION_SOURCES)[number];

export const OBSERVATION_STATUSES = ["success", "failed"] as const;
export type ObservationStatus = (typeof OBSERVATION_STATUSES)[number];

/** Safe, machine-readable failure reasons — the only failure detail ever stored or returned. */
export const OBSERVATION_FAILURE_REASONS = [
  "external_account_not_found",
  "account_mismatch",
  "authorization_required",
  "platform_api_error",
  "rate_limited",
  "unsupported_platform",
  "platform_not_configured",
] as const;
export type ObservationFailureReason =
  (typeof OBSERVATION_FAILURE_REASONS)[number];

const observedFields = {
  source: { type: String, enum: OBSERVATION_SOURCES },
  externalAccountId: { type: String },
  observedHandle: { type: String },
  // null = the platform hides the count (e.g. YouTube hidden subscriber count).
  observedFollowersCount: { type: Number, default: null },
  externalUrl: { type: String },
  // Platform-provided update time, if any — never used as capturedAt.
  rawPlatformUpdatedAt: { type: Date, default: null },
};

/**
 * Current state: one document per social account. The observed* fields always
 * describe the LATEST SUCCESSFUL observation (capturedAt). status/lastError/
 * lastAttemptAt describe the latest attempt, so a failed attempt never erases
 * the last good data.
 */
export const SocialAccountObservationSchema = new Schema(
  {
    profileType: { type: String, enum: SOCIAL_PROFILE_TYPES, required: true },
    profileId: { type: String, required: true },
    socialAccountId: { type: String, required: true },
    platformKey: { type: String, default: "" },
    ...observedFields,
    capturedAt: { type: Date, default: null },
    status: { type: String, enum: OBSERVATION_STATUSES, required: true },
    lastError: {
      type: String,
      enum: [...OBSERVATION_FAILURE_REASONS, null],
      default: null,
    },
    lastAttemptAt: { type: Date, required: true },
  },
  { collection: "social_account_observations", timestamps: true },
);

SocialAccountObservationSchema.index(
  { profileType: 1, profileId: 1, socialAccountId: 1 },
  { unique: true },
);

/** Append-only history: one document per observation attempt (admin-triggered, so low volume). */
export const SocialAccountObservationHistorySchema = new Schema(
  {
    profileType: { type: String, enum: SOCIAL_PROFILE_TYPES, required: true },
    profileId: { type: String, required: true },
    socialAccountId: { type: String, required: true },
    platformKey: { type: String, default: "" },
    status: { type: String, enum: OBSERVATION_STATUSES, required: true },
    reason: {
      type: String,
      enum: [...OBSERVATION_FAILURE_REASONS, null],
      default: null,
    },
    ...observedFields,
    // Server time of the attempt (successful or not).
    capturedAt: { type: Date, required: true },
    requestedById: { type: String, default: "" },
    requestedByRole: { type: String, default: "" },
  },
  {
    collection: "social_account_observation_history",
    timestamps: { createdAt: true, updatedAt: false },
  },
);

SocialAccountObservationHistorySchema.index({
  profileType: 1,
  profileId: 1,
  socialAccountId: 1,
  capturedAt: -1,
});

// Append-only: refuse any update/replace/delete issued through the model.
const HISTORY_MUTATIONS = [
  "updateOne",
  "updateMany",
  "findOneAndUpdate",
  "replaceOne",
  "findOneAndReplace",
  "deleteOne",
  "deleteMany",
  "findOneAndDelete",
] as const;
for (const op of HISTORY_MUTATIONS) {
  SocialAccountObservationHistorySchema.pre(op, function () {
    throw new Error("social_account_observation_history is append-only");
  });
}
SocialAccountObservationHistorySchema.pre("save", function () {
  if (!this.isNew) {
    throw new Error("social_account_observation_history is append-only");
  }
});
