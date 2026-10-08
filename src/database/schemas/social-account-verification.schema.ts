import { Schema } from "mongoose";

/**
 * Stage 3A-1 — per-social-account verification (admin decisions only).
 *
 * Deliberately NOT stored on profile.socialMedia[]:
 *  - profile documents are returned to brands/public largely as stored, so
 *    admin names, ids and notes would leak;
 *  - creator saves rewrite the whole socialMedia array (read-merge-write), so a
 *    decision landing mid-save would be silently lost.
 * Creator saves never touch these collections at all.
 *
 * `socialAccountId` is the Stage 3A-0 stable account id. A decision is only
 * valid while its snapshot (decidedHandle / decidedTier) still matches the
 * account's current handle / declared tier — see SocialAccountVerificationService.
 */
export const SOCIAL_VERIFICATION_STATUSES = [
  "pending",
  "verified",
  "rejected",
] as const;
export type SocialVerificationStatus =
  (typeof SOCIAL_VERIFICATION_STATUSES)[number];

export const SOCIAL_REVIEW_TYPES = ["ownership", "tier"] as const;
export type SocialReviewType = (typeof SOCIAL_REVIEW_TYPES)[number];

export const SOCIAL_PROFILE_TYPES = [
  "Influencer",
  "Brand",
  "Photographer",
] as const;
export type SocialProfileType = (typeof SOCIAL_PROFILE_TYPES)[number];

/** "manual" = explicit admin decision; "invalidated" = system reset after a handle/tier change. */
export const SOCIAL_REVIEW_METHODS = ["manual", "invalidated"] as const;

/**
 * Stage 3D-1b — what an admin decision rested on: a usable platform observation
 * (observed follower count) or a manual check (e.g. the admin opened the profile).
 * Optional: decisions made before 3D-1b have none.
 */
export const SOCIAL_EVIDENCE_BASES = ["observed", "manual_check"] as const;
export type SocialEvidenceBasis = (typeof SOCIAL_EVIDENCE_BASES)[number];

const DecisionFields = {
  status: {
    type: String,
    enum: SOCIAL_VERIFICATION_STATUSES,
    default: "pending",
  },
  method: { type: String, enum: SOCIAL_REVIEW_METHODS },
  evidenceBasis: { type: String, enum: SOCIAL_EVIDENCE_BASES },
  // Snapshot of what was actually reviewed (only one is used per review type).
  decidedHandle: { type: String },
  decidedTier: { type: String },
  decidedAt: { type: Date },
  decidedById: { type: String },
  decidedByName: { type: String },
  decidedByRole: { type: String },
  note: { type: String, default: "" },
  // Set when a handle/tier change reset a verified/rejected decision to pending.
  invalidatedAt: { type: Date },
  invalidatedReason: { type: String },
  // The decision that was invalidated, kept for context (full trail is in social_account_reviews).
  lastDecision: { type: Schema.Types.Mixed },
};

const DecisionSchema = new Schema(DecisionFields, { _id: false });

/** Current state: one document per social account. */
export const SocialAccountVerificationSchema = new Schema(
  {
    socialAccountId: { type: String, required: true },
    profileId: { type: String, required: true },
    profileType: { type: String, enum: SOCIAL_PROFILE_TYPES, required: true },
    platformKey: { type: String, default: "" },
    ownership: { type: DecisionSchema },
    tier: { type: DecisionSchema },
  },
  { collection: "social_account_verifications", timestamps: true },
);

SocialAccountVerificationSchema.index(
  { profileType: 1, profileId: 1, socialAccountId: 1 },
  { unique: true },
);

/** Append-only history: one document per decision or invalidation. Never updated. */
export const SocialAccountReviewSchema = new Schema(
  {
    socialAccountId: { type: String, required: true },
    profileId: { type: String, required: true },
    profileType: { type: String, enum: SOCIAL_PROFILE_TYPES, required: true },
    platformKey: { type: String, default: "" },
    platform: { type: String, default: "" },
    // State of the account at decision time.
    handle: { type: String, default: "" },
    declaredTier: { type: String, default: "" },
    reviewType: { type: String, enum: SOCIAL_REVIEW_TYPES, required: true },
    previousStatus: {
      type: String,
      enum: SOCIAL_VERIFICATION_STATUSES,
      required: true,
    },
    newStatus: {
      type: String,
      enum: SOCIAL_VERIFICATION_STATUSES,
      required: true,
    },
    method: { type: String, enum: SOCIAL_REVIEW_METHODS, required: true },
    evidenceBasis: { type: String, enum: SOCIAL_EVIDENCE_BASES },
    decidedAt: { type: Date, required: true },
    decidedById: { type: String, default: "" },
    decidedByName: { type: String, default: "" },
    decidedByRole: { type: String, default: "" },
    note: { type: String, default: "" },
  },
  {
    collection: "social_account_reviews",
    timestamps: { createdAt: true, updatedAt: false },
  },
);

SocialAccountReviewSchema.index({
  profileType: 1,
  profileId: 1,
  socialAccountId: 1,
  createdAt: -1,
});

// Append-only: refuse any update/replace/delete issued through the model.
const REVIEW_MUTATIONS = [
  "updateOne",
  "updateMany",
  "findOneAndUpdate",
  "replaceOne",
  "findOneAndReplace",
  "deleteOne",
  "deleteMany",
  "findOneAndDelete",
] as const;
for (const op of REVIEW_MUTATIONS) {
  SocialAccountReviewSchema.pre(op, function () {
    throw new Error("social_account_reviews is append-only");
  });
}
SocialAccountReviewSchema.pre("save", function () {
  if (!this.isNew) throw new Error("social_account_reviews is append-only");
});
