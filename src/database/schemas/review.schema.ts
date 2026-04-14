import { Schema } from "mongoose";

export const ReviewSchema = new Schema(
  {
    reviewerId: { type: String, required: true },
    reviewerType: {
      type: String,
      enum: ["brand", "influencer"],
      required: true,
    },
    targetId: { type: String, required: true },
    targetType: {
      type: String,
      enum: ["brand", "influencer"],
      required: true,
    },
    campaignId: { type: String, required: true },
    inviteId: { type: String, required: true },
    rating: { type: Number, required: true, min: 1, max: 5 },
    comment: { type: String, default: "" },
    /** pending → admin review → approved | rejected */
    status: {
      type: String,
      enum: ["pending", "approved", "rejected"],
      default: "pending",
    },
    adminNote: { type: String, default: "" },
  },
  { timestamps: true, collection: "reviews" },
);
