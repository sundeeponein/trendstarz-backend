import { Schema, Document } from "mongoose";

export const SocialProfileClickSchema = new Schema(
  {
    actorUserId: { type: Schema.Types.ObjectId, required: true, index: true },
    actorRole: {
      type: String,
      enum: ["brand", "influencer", "photographer"],
      required: true,
      index: true,
    },
    targetUserId: { type: Schema.Types.ObjectId, required: true, index: true },
    targetRole: {
      type: String,
      enum: ["brand", "influencer", "photographer"],
      required: true,
      index: true,
    },
    platform: { type: String, required: true, index: true },
    url: { type: String, required: true },
    source: { type: String, default: "profile" },
    day: { type: String, required: true, index: true },
    userAgent: { type: String, default: "" },
    ipHash: { type: String, default: "" },
  },
  { timestamps: true },
);

SocialProfileClickSchema.index({ actorUserId: 1, day: 1, platform: 1 });

export interface SocialProfileClick extends Document {
  actorUserId: string;
  actorRole: "brand" | "influencer" | "photographer";
  targetUserId: string;
  targetRole: "brand" | "influencer" | "photographer";
  platform: string;
  url: string;
  source?: string;
  day: string;
  userAgent?: string;
  ipHash?: string;
}
