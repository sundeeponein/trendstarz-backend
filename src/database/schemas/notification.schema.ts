import { Schema } from "mongoose";

export const NotificationSchema = new Schema(
  {
    userId: { type: String, required: true, index: true },
    userRole: { type: String, enum: ["brand", "influencer", "admin"], required: true },
    title: { type: String, required: true },
    body: { type: String, required: true },
    url: { type: String, default: "" },
    read: { type: Boolean, default: false, index: true },
  },
  { timestamps: true },
);

NotificationSchema.index({ userId: 1, createdAt: -1 });
