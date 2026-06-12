import { Schema } from "mongoose";

export const PROFILE_FLAG_CATEGORIES = [
  "Identity",
  "Location",
  "Social Media",
  "Content",
  "Portfolio",
  "Verification",
  "Payment",
] as const;

export const PROFILE_FLAG_CODES = [
  "PROFILE_PHOTO_PENDING_REVIEW",
  "PROFILE_PHOTO_MISSING",
  "PROFILE_PHOTO_SCREENSHOT",
  "PROFILE_PHOTO_CELEBRITY",
  "PROFILE_PHOTO_GROUP",
  "PROFILE_PHOTO_BLURRY",
  "PROFILE_PHOTO_LOGO",
  "FACE_NOT_VISIBLE",
  "LOCATION_MISSING",
  "LOCATION_MISMATCH",
  "INTERNATIONAL_LOCATION",
  "SOCIAL_LINK_MISSING",
  "SOCIAL_LINK_BROKEN",
  "SOCIAL_LINK_PRIVATE",
  "SOCIAL_LINK_MISMATCH",
  "SOCIAL_LINK_DUPLICATE",
  "FOLLOWER_COUNT_MISMATCH",
  "TIER_MISMATCH",
  "NICHE_MISSING",
  "NICHE_MISMATCH",
  "MEME_PAGE",
  "QUOTES_PAGE",
  "FAN_PAGE",
  "MUSIC_REPOST_PAGE",
  "INACTIVE_PROFILE",
  "PORTFOLIO_MISSING",
  "PORTFOLIO_SCREENSHOT",
  "PORTFOLIO_LOW_QUALITY",
  "PORTFOLIO_DUPLICATE",
  "PORTFOLIO_WATERMARK",
  "EMAIL_NOT_VERIFIED",
  "MOBILE_NOT_VERIFIED",
  "ID_PENDING",
  "PAYMENT_MISSING",
  "PAYMENT_PENDING",
  "PAYMENT_FAILED",
  "PAN_MISSING",
] as const;

export const ProfileFlagSchema = new Schema(
  {
    userId: { type: Schema.Types.Mixed, required: true, index: true },
    userType: {
      type: String,
      enum: ["Influencer", "Brand", "Photographer", "User"],
      default: "Influencer",
      index: true,
    },
    category: {
      type: String,
      enum: PROFILE_FLAG_CATEGORIES,
      required: true,
      index: true,
    },
    flagCode: {
      type: String,
      enum: PROFILE_FLAG_CODES,
      required: true,
      index: true,
    },
    severity: {
      type: String,
      enum: ["Low", "Medium", "High"],
      default: "Low",
      index: true,
    },
    message: { type: String, required: true },
    status: {
      type: String,
      enum: ["Open", "Resolved", "Ignored"],
      default: "Open",
      index: true,
    },
    createdBy: {
      type: String,
      enum: ["AUTO", "ADMIN"],
      default: "AUTO",
      index: true,
    },
    reviewedBy: { type: String, default: "" },
    reviewedAt: { type: Date, default: null },
    reviewNotes: { type: String, default: "" },
    auditLog: [
      {
        action: { type: String, required: true },
        actorId: { type: String, default: "" },
        actorRole: { type: String, default: "" },
        note: { type: String, default: "" },
        actedAt: { type: Date, default: Date.now },
      },
    ],
  },
  { collection: "profile_flags", timestamps: true },
);

ProfileFlagSchema.index({ userId: 1, userType: 1, flagCode: 1, status: 1 });
