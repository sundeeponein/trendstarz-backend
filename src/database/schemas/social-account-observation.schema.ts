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

/**
 * Stage 3D-1a — YouTube API Services Developer Policies (III.E.4): statistics
 * retrieved as Non-Authorized Data (our API-key lookups) must not be stored for
 * more than 30 days. Follower counts older than this are cleared (set to null,
 * stamped with statisticsPurgedAt) in both the current record and history.
 */
export const YOUTUBE_STATISTICS_RETENTION_DAYS = 30;
/** Query option that marks the ONE permitted history update (see the append-only hook). */
export const YOUTUBE_STATISTICS_PURGE_OPTION = "youtubeStatisticsRetention";

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
    // Stage 3D-1a: when an expired YouTube follower count was cleared (retention).
    statisticsPurgedAt: { type: Date, default: null },
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
    // "admin"/"subadmin" for a manual Fetch, "system" for the Stage 3D-1a schedule.
    requestedByRole: { type: String, default: "" },
    // Stage 3D-1a: when this row's YouTube follower count was cleared (retention).
    statisticsPurgedAt: { type: Date, default: null },
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

/**
 * The single exception to append-only: the YouTube statistics retention purge.
 * Allowed only as updateMany with the explicit purge option, on YouTube rows,
 * setting exactly observedFollowersCount=null and statisticsPurgedAt (callers
 * pass timestamps:false so mongoose adds no $setOnInsert). Identity, status and
 * timing are never touched; nothing is ever deleted.
 */
export function isYoutubeStatisticsPurge(query: {
  getOptions: () => Record<string, unknown>;
  getFilter: () => Record<string, unknown>;
  getUpdate: () => unknown;
}): boolean {
  if (query.getOptions()?.retentionPurge !== YOUTUBE_STATISTICS_PURGE_OPTION)
    return false;
  if (query.getFilter()?.source !== "youtube") return false;
  const update = query.getUpdate() as Record<string, any> | null;
  if (!update || Object.keys(update).join() !== "$set") return false;
  const set = update.$set as Record<string, unknown>;
  return (
    !!set &&
    Object.keys(set).sort().join() ===
      "observedFollowersCount,statisticsPurgedAt" &&
    set.observedFollowersCount === null &&
    set.statisticsPurgedAt instanceof Date
  );
}

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
    if (op === "updateMany" && isYoutubeStatisticsPurge(this as any)) return;
    throw new Error("social_account_observation_history is append-only");
  });
}
SocialAccountObservationHistorySchema.pre("save", function () {
  if (!this.isNew) {
    throw new Error("social_account_observation_history is append-only");
  }
});
