import { Schema } from "mongoose";

export const NotificationSchema = new Schema(
  {
    userId: { type: String, required: true, index: true },
    userRole: { type: String, enum: ["brand", "influencer", "photographer", "admin"], required: true },
    title: { type: String, required: true },
    body: { type: String, required: true },
    url: { type: String, default: "" },
    read: { type: Boolean, default: false, index: true },
  },
  { timestamps: true },
);

NotificationSchema.index({ userId: 1, createdAt: -1 });
// Retention (decided 2026-10-26): notifications are removed after 180 days.
export const NOTIFICATION_RETENTION_DAYS = 180;
NotificationSchema.index({ createdAt: 1 }, { expireAfterSeconds: NOTIFICATION_RETENTION_DAYS * 24 * 3600 });
