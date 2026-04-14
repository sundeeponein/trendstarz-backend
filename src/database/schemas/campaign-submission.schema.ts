import { Schema, Document } from "mongoose";

export const CampaignSubmissionSchema = new Schema(
  {
    campaignId: { type: Schema.Types.Mixed, ref: "Campaign", required: true },
    influencerId: {
      type: Schema.Types.ObjectId,
      ref: "Influencer",
      required: true,
    },
    inviteId: {
      type: Schema.Types.ObjectId,
      ref: "CampaignInvite",
      required: true,
    },

    postUrl: { type: String, required: true },
    postPlatform: { type: String }, // auto-detected from URL
    postType: {
      type: String,
      enum: ["reel", "video", "photo", "short", "story", "thread"],
    },
    captionUsed: { type: String },

    postScreenshotUrl: { type: String, required: true },
    insightsScreenshotUrl: { type: String },

    viewsCount: { type: Number },
    likesCount: { type: Number },
    commentsCount: { type: Number },
    sharesCount: { type: Number },
    reachCount: { type: Number },
    engagementRate: { type: Number },

    submittedAt: { type: Date },
    reviewedAt: { type: Date },

    status: {
      type: String,
      enum: ["draft", "submitted", "approved", "rejected", "disputed"],
      default: "submitted",
    },
    brandFeedback: { type: String },
    disputeReason: { type: String },
  },
  { timestamps: true },
);

export interface CampaignSubmission extends Document {
  campaignId: string;
  influencerId: string;
  inviteId: string;
  postUrl: string;
  postPlatform?: string;
  postType?: string;
  captionUsed?: string;
  postScreenshotUrl: string;
  insightsScreenshotUrl?: string;
  viewsCount?: number;
  likesCount?: number;
  commentsCount?: number;
  sharesCount?: number;
  reachCount?: number;
  engagementRate?: number;
  submittedAt?: Date;
  reviewedAt?: Date;
  status: "draft" | "submitted" | "approved" | "rejected" | "disputed";
  brandFeedback?: string;
  disputeReason?: string;
  createdAt: Date;
}
